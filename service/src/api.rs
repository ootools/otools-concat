use crate::{
    auth::Guard,
    media::safe_cache_name,
    probe::{self, MediaInfo},
    render::{RenderRegistry, RenderRequest, build_args, render_id, run_job},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response, sse::{Event as SseEvent, KeepAlive, Sse}},
    routing::{get, post},
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, SeekFrom},
    sync::Mutex,
};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tokio_util::io::ReaderStream;
use tokio_util::sync::CancellationToken;

const MAX_TEXT_ASSET: usize = 12 * 1024 * 1024;
const MAX_CACHE_BYTES: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub guard: Guard,
    pub origin: String,
    pub ffmpeg: String,
    pub ffprobe: String,
    cache_dir: Arc<PathBuf>,
    media: Arc<Mutex<HashMap<String, RegisteredMedia>>>,
    text_assets: Arc<Mutex<HashMap<String, PathBuf>>>,
    renders: Arc<Mutex<RenderRegistry>>,
    generation: Arc<Mutex<()>>,
    started: Instant,
    shutdown: CancellationToken,
}

#[derive(Clone)]
struct RegisteredMedia {
    path: PathBuf,
    info: MediaInfo,
}

impl AppState {
    pub fn new(token: String, origin: String, ffmpeg: String, ffprobe: String, port: u16) -> Self {
        let cache_dir = std::env::temp_dir().join(format!(
            "concatd-{}-{}-{port}",
            std::process::id(),
            tokio::time::Instant::now().elapsed().as_nanos() % 1_000_000
        ));
        Self {
            guard: Guard::new(token, origin.clone(), port),
            origin,
            ffmpeg,
            ffprobe,
            cache_dir: Arc::new(cache_dir),
            media: Arc::new(Mutex::new(HashMap::new())),
            text_assets: Arc::new(Mutex::new(HashMap::new())),
            renders: Arc::new(Mutex::new(RenderRegistry::default())),
            generation: Arc::new(Mutex::new(())),
            started: Instant::now(),
            shutdown: CancellationToken::new(),
        }
    }

    fn cache_dir(&self) -> PathBuf {
        (*self.cache_dir).clone()
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        self.renders.lock().await.shutdown().await;
        let _ = tokio::fs::remove_dir_all(self.cache_dir()).await;
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/probe", post(probe_media))
        .route("/api/media/{mediaId}", get(serve_original))
        .route("/api/media/{mediaId}/preview.mp4", get(serve_preview))
        .route("/api/media/{mediaId}/thumb.jpg", get(serve_thumb))
        .route("/api/media/{mediaId}/peaks.json", get(serve_peaks))
        .route("/api/assets/text", post(upload_text))
        .route("/api/assets/text/{file}", get(serve_text_asset))
        .route("/api/render", post(start_render))
        .route("/api/render/{id}", get(render_status))
        .route("/api/render/{id}/events", get(render_events))
        .route("/api/render/{id}/cancel", post(cancel_render))
        .route("/api/project", post(save_project).get(read_project))
        .route("/api/close", post(close))
        .fallback(not_found)
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, auth_and_cors))
}

async fn auth_and_cors(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    // <video>/<img> 无法设置 Authorization 头；GET 请求允许用一次性 query token
    // 回退（监听只在 loopback + origin/host 双重校验，token 每会话随机）。
    let request = if request.method() == Method::GET
        && request.headers().get(header::AUTHORIZATION).is_none()
        && request
            .uri()
            .query()
            .and_then(|query| query.split('&').find(|pair| pair.starts_with("access_token=")))
            .and_then(|pair| pair.strip_prefix("access_token="))
            .map(|value| value == state.guard.token())
            .unwrap_or(false)
    {
        let (mut parts, body) = request.into_parts();
        parts.headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", state.guard.token())).unwrap_or_else(|_| HeaderValue::from_static("Bearer ")),
        );
        Request::from_parts(parts, body)
    } else {
        request
    };
    match state.guard.check(request.method(), request.headers()) {
        Ok(()) if request.method() == Method::OPTIONS => {
            let mut response = StatusCode::NO_CONTENT.into_response();
            add_cors(response.headers_mut(), &state.origin);
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, OPTIONS"),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("Authorization, Content-Type, Range"),
            );
            response.headers_mut().insert(
                header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static("600"),
            );
            response
        }
        Ok(()) => {
            let shutdown = state.shutdown.clone();
            let operation = tokio::spawn(async move {
                tokio::select! {
                    result = next.run(request) => result,
                    _ = shutdown.cancelled() => error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down"),
                }
            });
            let mut response = operation
                .await
                .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "request failed"));
            add_cors(response.headers_mut(), &state.origin);
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response.headers_mut().insert(
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            );
            response
        }
        Err(status) => status.into_response(),
    }
}

fn add_cors(headers: &mut HeaderMap, origin: &str) {
    if let Ok(value) = HeaderValue::from_str(origin) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    }
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
}

fn error(status: StatusCode, message: impl AsRef<str>) -> Response {
    (status, Json(json!({"error": message.as_ref()}))).into_response()
}

#[derive(Serialize)]
struct StatusResponse {
    uptime_seconds: u64,
    media_registered: usize,
    renders_active: usize,
}

async fn status(State(state): State<AppState>) -> Json<StatusResponse> {
    let renders_active = state.renders.lock().await.jobs_active();
    Json(StatusResponse {
        uptime_seconds: state.started.elapsed().as_secs(),
        media_registered: state.media.lock().await.len(),
        renders_active,
    })
}

async fn close(State(state): State<AppState>) -> Response {
    state.renders.lock().await.shutdown().await;
    state.media.lock().await.clear();
    state.text_assets.lock().await.clear();
    let _ = tokio::fs::remove_dir_all(state.cache_dir()).await;
    Json(json!({"ok": true})).into_response()
}

#[derive(Deserialize)]
pub struct ProbeRequest {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResponse {
    media_id: String,
    info: MediaInfo,
    preview_mode: String,
}

async fn probe_media(State(state): State<AppState>, Json(body): Json<ProbeRequest>) -> Response {
    if state.shutdown.is_cancelled() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down");
    }
    let result = probe::probe_with_cancel(&state.ffprobe, &body.path, &state.shutdown).await;
    match result {
        Ok((canonical, info)) => {
            let preview_mode = probe::preview_mode(&info);
            let media_id = probe::media_id(&canonical);
            state.media.lock().await.insert(
                media_id.clone(),
                RegisteredMedia {
                    path: canonical,
                    info: info.clone(),
                },
            );
            Json(ProbeResponse {
                media_id,
                info,
                preview_mode: preview_mode.into(),
            })
            .into_response()
        }
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}

async fn lookup(state: &AppState, media_id: &str) -> Option<RegisteredMedia> {
    state.media.lock().await.get(media_id).cloned()
}

async fn serve_original(
    State(state): State<AppState>,
    Path(media_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(registered) = lookup(&state, &media_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    serve_file(&registered.path, &headers, mime_for(&registered.info)).await
}

async fn serve_preview(
    State(state): State<AppState>,
    Path(media_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(registered) = lookup(&state, &media_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match probe::preview_mode(&registered.info) {
        "browser" => serve_file(&registered.path, &headers, "video/mp4").await,
        mode => {
            // 派生预览（remux/proxy）：先确保缓存产物存在（互斥，避免并发 ffmpeg）。
            let generation = state.generation.clone();
            let _guard = generation.lock().await;
            let target = state.cache_dir().join(&media_id).join(if mode == "remux" {
                "remux.mp4"
            } else {
                "proxy.mp4"
            });
            if !target.exists() {
                if let Some(parent) = target.parent() {
                    let _ = tokio::fs::create_dir_all(parent).await;
                }
                let partial = target.with_extension("part.mp4");
                let args = preview_args(&registered, mode, &partial);
                if let Err(message) = args {
                    return error(StatusCode::BAD_REQUEST, message);
                }
                let mut command = crate::process::render_command(&state.ffmpeg);
                command.args(args.unwrap());
                let mut child = match command.spawn() {
                    Ok(child) => child,
                    Err(_) => return error(StatusCode::BAD_REQUEST, "preview cannot be generated"),
                };
                // 丢弃 stderr（诊断不落 sidecar 输出），等待结束。
                let _ = child.stderr.take();
                let status = child.wait().await;
                if !matches!(status, Ok(code) if code.success()) {
                    let _ = tokio::fs::remove_file(&partial).await;
                    return error(StatusCode::BAD_REQUEST, "preview generation failed");
                }
                let _ = tokio::fs::rename(&partial, &target).await;
            }
            drop(_guard);
            enforce_cache_limit(state.cache_dir()).await;
            serve_file(&target, &headers, "video/mp4").await
        }
    }
}

fn preview_args(registered: &RegisteredMedia, mode: &str, output: &FsPath) -> Result<Vec<String>, &'static str> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-protocol_whitelist".into(),
        "file".into(),
        "-format_whitelist".into(),
        crate::process::FORMAT_WHITELIST.into(),
        "-i".into(),
        registered.path.to_string_lossy().into_owned(),
    ];
    if mode == "remux" {
        args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0?".into(), "-c".into(), "copy".into(), "-tag:v".into(), "avc1".into()]);
    } else {
        args.extend([
            "-map".into(),
            "0:v:0?".into(),
            "-map".into(),
            "0:a:0?".into(),
            "-vf".into(),
            "scale='min(1280,iw)':-2".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            "26".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "128k".into(),
        ]);
    }
    args.extend(["-movflags".into(), "+faststart".into(), "-f".into(), "mp4".into(), "-y".into(), output.to_string_lossy().into_owned()]);
    Ok(args)
}

#[derive(Deserialize)]
struct ThumbQuery {
    #[serde(default)]
    at: f64,
}

async fn serve_thumb(
    State(state): State<AppState>,
    Path(media_id): Path<String>,
    Query(query): Query<ThumbQuery>,
) -> Response {
    let Some(registered) = lookup(&state, &media_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if registered.info.kind == "audio" {
        return StatusCode::NOT_FOUND.into_response();
    }
    // 时间点按 0.1s 分桶缓存，拖动时间线时重复请求命中缓存。
    let bucket = (query.at.max(0.0) * 10.0).round() / 10.0;
    let max_at = if registered.info.duration > 0.0 {
        registered.info.duration
    } else {
        0.0
    };
    let at = bucket.min(max_at);
    let target = state
        .cache_dir()
        .join(&media_id)
        .join(format!("thumb-{at:.1}.jpg"));
    if !target.exists() {
        let generation = state.generation.clone();
        let _guard = generation.lock().await;
        if !target.exists() {
            if let Some(parent) = target.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            match probe::thumbnail(&state.ffmpeg, &registered.path, at, &state.shutdown).await {
                Ok(bytes) if !bytes.is_empty() => {
                    let _ = tokio::fs::write(&target, &bytes).await;
                }
                _ => return StatusCode::NOT_FOUND.into_response(),
            }
        }
    }
    match tokio::fs::read(&target).await {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=3600")],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn serve_peaks(
    State(state): State<AppState>,
    Path(media_id): Path<String>,
) -> Response {
    let Some(registered) = lookup(&state, &media_id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if registered.info.audio_tracks.is_empty() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let target = state.cache_dir().join(&media_id).join("peaks.json");
    if !target.exists() {
        let generation = state.generation.clone();
        let _guard = generation.lock().await;
        if !target.exists() {
            match probe::audio_peaks(&state.ffmpeg, &registered.path, &state.shutdown).await {
                Ok(peaks) if !peaks.is_empty() => {
                    if let Some(parent) = target.parent() {
                        let _ = tokio::fs::create_dir_all(parent).await;
                    }
                    let _ = tokio::fs::write(
                        &target,
                        serde_json::to_vec(&json!({"peaks": peaks})).unwrap_or_default(),
                    )
                    .await;
                }
                _ => return StatusCode::NOT_FOUND.into_response(),
            }
        }
    }
    match tokio::fs::read(&target).await {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "private, max-age=3600")],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextAssetRequest {
    data_base64: String,
}

async fn upload_text(State(state): State<AppState>, Json(body): Json<TextAssetRequest>) -> Response {
    if state.shutdown.is_cancelled() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down");
    }
    if body.data_base64.len() > MAX_TEXT_ASSET * 4 / 3 + 8 {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "text asset exceeds limit");
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&body.data_base64) {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::BAD_REQUEST, "text asset is not valid base64"),
    };
    if bytes.len() > MAX_TEXT_ASSET {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "text asset exceeds limit");
    }
    // 只收 PNG 或 QOI（canvas 导出的透明叠加层；本运行时无 zlib，前端编码为 QOI）。
    let extension = if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        "png"
    } else if bytes.starts_with(&[0x71, 0x6f, 0x69, 0x66]) {
        "qoi"
    } else {
        return error(StatusCode::BAD_REQUEST, "text asset must be a PNG or QOI image");
    };
    let id = render_id().replace('r', "t");
    let target = state.cache_dir().join("text").join(format!("{id}.{extension}"));
    if let Some(parent) = target.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    if tokio::fs::write(&target, &bytes).await.is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "text asset cannot be stored");
    }
    state.text_assets.lock().await.insert(id.clone(), target);
    Json(json!({"assetId": id})).into_response()
}

async fn serve_text_asset(State(state): State<AppState>, Path(file): Path<String>) -> Response {
    if !safe_cache_name(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = state.cache_dir().join("text").join(&file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "private, max-age=3600")],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderStartResponse {
    render_id: String,
}

async fn start_render(State(state): State<AppState>, Json(body): Json<RenderRequest>) -> Response {
    if state.shutdown.is_cancelled() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down");
    }
    // 输入必须是已登记的媒体（防任意文件读取）；文字资产由 assetId 前缀内联替换。
    let mut resolved = body.clone();
    let mut has_audio = false;
    for (index, input) in resolved.inputs.iter_mut().enumerate() {
        if let Some(asset_ref) = input.path.as_deref().filter(|path| path.starts_with("asset:")) {
            let asset_id = asset_ref.trim_start_matches("asset:");
            let path = state.text_assets.lock().await.get(asset_id).cloned();
            match path {
                Some(path) => input.path = Some(path.to_string_lossy().into_owned()),
                None => return error(StatusCode::BAD_REQUEST, format!("input {index} is not a registered asset")),
            }
        } else {
            let Some(path) = input.path.clone() else {
                return error(StatusCode::BAD_REQUEST, "render input missing path");
            };
            let canonical = tokio::fs::canonicalize(&path).await.ok();
            let registered = canonical
                .as_ref()
                .map(|canonical| probe::media_id(canonical))
                .and_then(|id| {
                    state
                        .media
                        .try_lock()
                        .ok()
                        .and_then(|media| media.get(&id).cloned())
                });
            match registered {
                Some(registered) => {
                    if registered.info.has_audio {
                        has_audio = true;
                    }
                    input.path = Some(registered.path.to_string_lossy().into_owned());
                }
                None => return error(StatusCode::BAD_REQUEST, format!("input {index} is not a registered media")),
            }
        }
    }
    // 输出路径校验：绝对路径 + 父目录存在（save 对话框给出的路径）。
    let output = PathBuf::from(&resolved.output);
    if !output.is_absolute()
        || output.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()) != Some("mp4".into())
        || match output.parent() {
            Some(parent) => !tokio::fs::metadata(parent).await.map(|meta| meta.is_dir()).unwrap_or(false),
            None => true,
        }
    {
        return error(StatusCode::BAD_REQUEST, "output path is invalid");
    }
    resolved.has_audio = Some(has_audio && resolved.has_audio.unwrap_or(true));
    let args = match build_args(&resolved, &output) {
        Ok(args) => args,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    let id = render_id();
    let mut registry = state.renders.lock().await;
    let handle = match registry.start(id.clone(), resolved).await {
        Ok(handle) => handle,
        Err(message) => return error(StatusCode::CONFLICT, message),
    };
    let (output_path, ffmpeg, registry_arc, job_id) = (
        output.clone(),
        state.ffmpeg.clone(),
        state.renders.clone(),
        id.clone(),
    );
    tokio::spawn(run_job(handle, ffmpeg, args, output_path, registry_arc, job_id));
    Json(RenderStartResponse { render_id: id }).into_response()
}

async fn render_status(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let registry = state.renders.lock().await;
    if let Some(handle) = registry.get(&id) {
        let progress = handle.progress.lock().await.clone();
        return Json(progress).into_response();
    }
    // 已结束（含失败/取消）：归档终态仍可查询，前端能拿到失败原因。
    if let Some(progress) = registry.finished(&id) {
        return Json(progress).into_response();
    }
    StatusCode::NOT_FOUND.into_response()
}

async fn render_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    let Some(handle) = state.renders.lock().await.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let receiver = handle.events.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|result| {
        result
            .ok()
            .map(|payload| Ok::<_, std::convert::Infallible>(SseEvent::default().data(payload)))
    });
    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

async fn cancel_render(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut registry = state.renders.lock().await;
    if registry.get(&id).is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    registry.remove(&id).await;
    Json(json!({"ok": true})).into_response()
}

fn mime_for(info: &MediaInfo) -> &'static str {
    match info.kind.as_str() {
        "audio" => "audio/mpeg",
        "image" => "image/png",
        _ => "video/mp4",
    }
}

/// 带 Range 支持的文件流式服务（原文件可能数 GB，禁止整读内存）。
async fn serve_file(path: &FsPath, headers: &HeaderMap, mime: &'static str) -> Response {
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let length = metadata.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_range)
        .and_then(|(start, end)| {
            let end = end.unwrap_or(length.saturating_sub(1)).min(length.saturating_sub(1));
            (start < length && start <= end).then_some((start, end))
        });
    let mut file = match File::open(path).await {
        Ok(file) => file,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let mut response_builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes");
    let body = match range {
        Some((start, end)) => {
            if file.seek(SeekFrom::Start(start)).await.is_err() {
                return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            }
            let stream = ReaderStream::with_capacity(file.take(end - start + 1), 256 * 1024);
            response_builder = response_builder
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{length}"))
                .status(StatusCode::PARTIAL_CONTENT);
            Body::from_stream(stream)
        }
        None => Body::from_stream(ReaderStream::with_capacity(file, 256 * 1024)),
    };
    response_builder.body(body).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn parse_range(value: &str) -> Option<(u64, Option<u64>)> {
    let rest = value.strip_prefix("bytes=")?;
    let (start, end) = rest.split_once('-')?;
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() { None } else { Some(end.parse::<u64>().ok()?) };
    Some((start, end))
}

/// 派生缓存上限（8GB）：超限则按修改时间清掉最旧的产物目录。
async fn enforce_cache_limit(root: PathBuf) {
    let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
        return;
    };
    let mut items: Vec<(PathBuf, u64, std::time::SystemTime)> = Vec::new();
    let mut total = 0u64;
    while let Ok(Some(entry)) = entries.next_entry().await {
        let Ok(metadata) = entry.metadata().await else { continue };
        if !metadata.is_dir() {
            continue;
        }
        let size = dir_size(&entry.path()).await;
        let modified = metadata.modified().unwrap_or_else(|_| std::time::SystemTime::now());
        total = total.saturating_add(size);
        items.push((entry.path(), size, modified));
    }
    if total <= MAX_CACHE_BYTES {
        return;
    }
    items.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in items {
        if total <= MAX_CACHE_BYTES {
            break;
        }
        if tokio::fs::remove_dir_all(&path).await.is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

async fn dir_size(path: &FsPath) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else { continue };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(metadata) = entry.metadata().await else { continue };
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    total
}

const MAX_PROJECT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectRequest {
    path: String,
    data_base64: String,
}

/// 工程文件保存：只允许绝对路径 + .concatproj 扩展名（save 对话框给出）。
async fn save_project(State(state): State<AppState>, Json(body): Json<SaveProjectRequest>) -> Response {
    use base64::Engine;
    if state.shutdown.is_cancelled() {
        return error(StatusCode::SERVICE_UNAVAILABLE, "service is shutting down");
    }
    let path = PathBuf::from(&body.path);
    let ext_ok = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("concatproj"))
        .unwrap_or(false);
    if !path.is_absolute() || body.path.contains('\0') || body.path.len() > 32768 || !ext_ok {
        return error(StatusCode::BAD_REQUEST, "project path must be an absolute .concatproj file");
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(&body.data_base64) {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::BAD_REQUEST, "project payload is not valid base64"),
    };
    if bytes.len() > MAX_PROJECT_BYTES {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "project exceeds limit");
    }
    let temp = path.with_extension("concatproj.part");
    if tokio::fs::write(&temp, &bytes).await.is_err() {
        return error(StatusCode::BAD_REQUEST, "project file cannot be written");
    }
    if tokio::fs::rename(&temp, &path).await.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
        return error(StatusCode::BAD_REQUEST, "project file cannot be written");
    }
    Json(json!({"ok": true})).into_response()
}

/// 工程文件读取：只允许 .concatproj，限 16MB（open 对话框给出）。
#[derive(Deserialize)]
struct ReadProjectQuery {
    path: String,
}

async fn read_project(State(_state): State<AppState>, Query(query): Query<ReadProjectQuery>) -> Response {
    use base64::Engine;
    let path = PathBuf::from(&query.path);
    let ext_ok = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("concatproj"))
        .unwrap_or(false);
    if !path.is_absolute() || !ext_ok {
        return error(StatusCode::BAD_REQUEST, "only .concatproj files are supported");
    }
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_PROJECT_BYTES as u64 => metadata,
        _ => return error(StatusCode::BAD_REQUEST, "project file cannot be read"),
    };
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::BAD_REQUEST, "project file cannot be read"),
    };
    Json(json!({
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        "size": metadata.len(),
    }))
    .into_response()
}

async fn not_found() -> StatusCode {
    StatusCode::NOT_FOUND
}

impl RenderRegistry {
    fn jobs_active(&self) -> usize {
        self.active()
    }
}
