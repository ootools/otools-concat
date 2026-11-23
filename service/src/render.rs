use crate::process::{FORMAT_WHITELIST, render_command, terminate};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{io::AsyncReadExt, sync::{Mutex, broadcast}};
use tokio_util::sync::CancellationToken;

const MAX_INPUTS: usize = 64;
const MAX_FILTER_COMPLEX: usize = 1024 * 1024;
const MAX_DURATION: f64 = 4.0 * 3600.0;
const MAX_CONCURRENT: usize = 2;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderInput {
    pub path: Option<String>,
    #[serde(default)]
    pub loop_image: bool,
    #[serde(default)]
    pub image_duration: f64,
    /// lavfi 合成源（如 anullsrc 静音），与 path 互斥；duration 限定长度。
    #[serde(default)]
    pub lavfi: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub inputs: Vec<RenderInput>,
    pub filter_complex: String,
    pub expected_duration: f64,
    pub output: String,
    pub quality: Option<String>,
    pub has_audio: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderProgress {
    pub state: String,
    pub seconds: f64,
    pub percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub struct RenderHandle {
    pub(crate) request: RenderRequest,
    pub(crate) progress: Mutex<RenderProgress>,
    pub(crate) events: broadcast::Sender<String>,
    pub(crate) child: Mutex<Option<tokio::process::Child>>,
    pub(crate) shutdown: CancellationToken,
    /// 失败诊断：ffmpeg stderr 尾部（仅渲染任务自己的输出，无敏感信息）。
    pub(crate) diagnostic: Mutex<Vec<String>>,
}

impl RenderHandle {
    fn broadcast(&self, payload: &str) {
        let _ = self.events.send(payload.to_owned());
    }

    async fn set_progress(&self, progress: RenderProgress) {
        *self.progress.lock().await = progress.clone();
        self.broadcast(&serde_json::to_string(&progress).unwrap_or_default());
    }
}

#[derive(Default)]
pub struct RenderRegistry {
    jobs: HashMap<String, Arc<RenderHandle>>,
    finished: HashMap<String, RenderProgress>,
}

impl RenderRegistry {
    pub async fn start(&mut self, id: String, request: RenderRequest) -> Result<Arc<RenderHandle>, &'static str> {
        if self.jobs.len() >= MAX_CONCURRENT {
            return Err("too many concurrent renders");
        }
        let handle = Arc::new(RenderHandle {
            request,
            progress: Mutex::new(RenderProgress { state: "running".into(), seconds: 0.0, percent: 0.0, message: None }),
            events: broadcast::channel(64).0,
            child: Mutex::new(None),
            shutdown: CancellationToken::new(),
            diagnostic: Mutex::new(Vec::new()),
        });
        self.jobs.insert(id.clone(), handle.clone());
        Ok(handle)
    }

    pub fn get(&self, id: &str) -> Option<Arc<RenderHandle>> {
        self.jobs.get(id).cloned()
    }

    pub fn active(&self) -> usize {
        self.jobs.len()
    }

    pub async fn remove(&mut self, id: &str) {
        if let Some(handle) = self.jobs.remove(id) {
            handle.shutdown.cancel();
            let mut child = handle.child.lock().await;
            if let Some(child) = child.as_mut() {
                terminate(child).await;
            }
        }
    }

    /// 任务终态归档（供完成后的状态轮询读取，进程退出后不再 alive）。
    pub async fn archive(&mut self, id: &str, progress: RenderProgress) {
        self.finished.insert(id.to_owned(), progress);
        if self.finished.len() > 64 {
            // 按插入序淘汰最旧
            if let Some(first) = self.finished.keys().next().cloned() {
                self.finished.remove(&first);
            }
        }
    }

    pub fn finished(&self, id: &str) -> Option<RenderProgress> {
        self.finished.get(id).cloned()
    }

    pub async fn shutdown(&mut self) {
        for handle in self.jobs.values() {
            handle.shutdown.cancel();
            let mut child = handle.child.lock().await;
            if let Some(child) = child.as_mut() {
                terminate(child).await;
            }
        }
        self.jobs.clear();
        self.finished.clear();
    }
}

/// 组装并启动 ffmpeg 渲染任务。argv 完全由服务端拼装：前端只提供已登记的
/// 输入路径、filter_complex 脚本与质量档位，不传任意额外参数。
pub fn build_args(request: &RenderRequest, output: &Path) -> Result<Vec<String>, &'static str> {
    if request.inputs.is_empty() || request.inputs.len() > MAX_INPUTS {
        return Err("invalid input count");
    }
    if request.filter_complex.is_empty() || request.filter_complex.len() > MAX_FILTER_COMPLEX {
        return Err("invalid filter_complex");
    }
    if !(request.expected_duration.is_finite() && request.expected_duration > 0.0 && request.expected_duration <= MAX_DURATION) {
        return Err("invalid expected duration");
    }
    if !output.is_absolute() || output.as_os_str().is_empty() {
        return Err("output path must be absolute");
    }
    if output.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()) != Some("mp4".into()) {
        return Err("output must be an .mp4 file");
    }
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "info".into(),
        "-nostdin".into(),
        "-protocol_whitelist".into(),
        "file".into(),
        "-format_whitelist".into(),
        FORMAT_WHITELIST.into(),
    ];
    for input in &request.inputs {
        if let Some(spec) = input.lavfi.as_deref() {
            // lavfi 合成源（静音填充等）：-f lavfi -i <spec>，必须限时。
            let duration = input.duration.unwrap_or(0.0);
            if !(duration.is_finite() && duration > 0.0 && duration <= MAX_DURATION) {
                return Err("invalid lavfi duration");
            }
            args.extend(["-f".into(), "lavfi".into(), "-t".into(), format!("{duration:.3}"), "-i".into(), spec.to_owned()]);
            continue;
        }
        let Some(path) = input.path.as_deref() else {
            return Err("render input missing path");
        };
        if !Path::new(path).is_absolute() || path.contains('\0') || path.len() > 32768 {
            return Err("render input path must be absolute");
        }
        if input.loop_image {
            // 静态图：循环为指定时长的视频流（无需音频）。
            let duration = if input.image_duration.is_finite() && input.image_duration > 0.0 && input.image_duration <= MAX_DURATION {
                input.image_duration
            } else {
                return Err("invalid image duration");
            };
            args.push("-loop".into());
            args.push("1".into());
            args.push("-t".into());
            args.push(format!("{duration:.3}"));
        }
        args.push("-i".into());
        args.push(path.to_owned());
    }
    args.push("-filter_complex".into());
    args.push(request.filter_complex.clone());
    let quality = request.quality.as_deref().unwrap_or("medium");
    let crf = match quality {
        "high" => "20",
        "low" => "28",
        "medium" => "23",
        _ => return Err("invalid quality"),
    };
    args.push("-c:v".into());
    args.push("libx264".into());
    args.push("-preset".into());
    args.push("veryfast".into());
    args.push("-crf".into());
    args.push(crf.into());
    args.push("-pix_fmt".into());
    args.push("yuv420p".into());
    if request.has_audio.unwrap_or(true) {
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    }
    args.push("-movflags".into());
    args.push("+faststart".into());
    args.push("-y".into());
    args.push(output.to_string_lossy().into_owned());
    Ok(args)
}


/// 解析 ffmpeg stderr 的 time=HH:MM:SS.xx 行。
pub fn parse_time(line: &str) -> Option<f64> {
    let index = line.find("time=")?;
    let rest = &line[index + 5..];
    let end = rest
        .find(|ch: char| !(ch.is_ascii_digit() || ch == ':' || ch == '.'))
        .unwrap_or(rest.len());
    let value = &rest[..end];
    let mut seconds = 0.0;
    for part in value.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    seconds.is_finite().then_some(seconds)
}

pub fn render_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("r{nanos:x}")
}

/// 启动渲染子进程并驱动进度事件（由 api 层调用）。
pub async fn run_job(
    handle: Arc<RenderHandle>,
    ffmpeg: String,
    args: Vec<String>,
    output: PathBuf,
    registry: Arc<Mutex<RenderRegistry>>,
    job_id: String,
) {
    let shutdown = handle.shutdown.clone();
    let mut command = render_command(&ffmpeg);
    command.args(&args);
    let spawn_result = command.spawn();
    let mut child = match spawn_result {
        Ok(child) => child,
        Err(_) => {
            let progress = RenderProgress { state: "failed".into(), seconds: 0.0, percent: 0.0, message: Some("ffmpeg cannot be started".into()) };
            handle.set_progress(progress.clone()).await;
            registry.lock().await.archive(&job_id, progress).await;
            return;
        }
    };
    // stderr 一次性 take 给进度泵任务（只拥有流，不与状态等待抢锁）。
    let stderr = child.stderr.take();
    *handle.child.lock().await = Some(child);
    let total = handle.request.expected_duration;
    let pump_handle = handle.clone();
    let stderr_task = tokio::spawn(async move {
        let Some(stderr) = stderr else { return };
        let mut lines = stderr_lines_owned(stderr);
        while let Some(line) = lines.next().await {
            // 所有 stderr 行进诊断环（ffmpeg 报错行没有 time=），time= 行另发进度。
            {
                let mut diagnostic = pump_handle.diagnostic.lock().await;
                if diagnostic.len() >= 32 {
                    let excess = diagnostic.len() + 1 - 32;
                    diagnostic.drain(..excess);
                }
                diagnostic.push(line.clone());
            }
            if let Some(seconds) = parse_time(&line) {
                let percent = if total > 0.0 {
                    ((seconds / total) * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                };
                let progress = RenderProgress { state: "running".into(), seconds, percent, message: None };
                if let Ok(mut guard) = pump_handle.progress.try_lock() {
                    *guard = progress.clone();
                }
                pump_handle.broadcast(&serde_json::to_string(&progress).unwrap_or_default());
            }
        }
    });
    // 状态等待独占子进程锁；取消也在这把锁内完成，避免锁竞争死锁。
    let status = {
        let mut guard = handle.child.lock().await;
        match guard.as_mut() {
            Some(child) => {
                tokio::select! {
                    status = child.wait() => status,
                    _ = shutdown.cancelled() => {
                        terminate(child).await;
                        child.wait().await
                    }
                }
            }
            None => Err(std::io::Error::other("render child exited unexpectedly")),
        }
    };
    let _ = stderr_task.await;
    let cancelled = shutdown.is_cancelled();
    let final_state = match (&status, cancelled) {
        (Ok(code), false) if code.success() => "done",
        (Ok(_), false) => "failed",
        (_, true) => "cancelled",
        _ => "failed",
    };
    if final_state != "done" {
        // 半成品/失败输出立即删除，避免用户误取损坏文件。
        let _ = tokio::fs::remove_file(&output).await;
    }
    let percent = if final_state == "done" { 100.0 } else { 0.0 };
    let message = if final_state == "failed" {
        let diagnostic = handle.diagnostic.lock().await;
        let tail: Vec<&str> = diagnostic.iter().rev().take(6).rev().map(String::as_str).collect();
        Some(if tail.is_empty() {
            "ffmpeg exited with an error".to_owned()
        } else {
            format!("ffmpeg: {}", tail.join(" | "))
        })
    } else {
        None
    };
    let progress = RenderProgress { state: final_state.into(), seconds: 0.0, percent, message };
    handle.set_progress(progress.clone()).await;
    let mut registry_guard = registry.lock().await;
    registry_guard.archive(&job_id, progress).await;
    registry_guard.remove(&job_id).await;
}

/// 逐行读取自有的 stderr 流（\r 分行，ffmpeg 进度行用 \r 刷新）。
fn stderr_lines_owned(stderr: tokio::process::ChildStderr) -> LineStream {
    LineStream { stderr, buffer: Vec::new() }
}

struct LineStream {
    stderr: tokio::process::ChildStderr,
    buffer: Vec<u8>,
}

impl LineStream {
    async fn next(&mut self) -> Option<String> {
        loop {
            if let Some(position) = self.buffer.iter().rposition(|byte| *byte == b'\r' || *byte == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=position).collect();
                let text = String::from_utf8_lossy(&line)
                    .trim_matches(['\r', '\n'])
                    .to_owned();
                if !text.is_empty() && text.len() <= 8192 {
                    return Some(text);
                }
                continue;
            }
            let mut chunk = [0u8; 4096];
            match self.stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => {
                    if self.buffer.is_empty() {
                        return None;
                    }
                    let text = String::from_utf8_lossy(&self.buffer)
                        .trim_matches(['\r', '\n'])
                        .to_owned();
                    self.buffer.clear();
                    return (!text.is_empty() && text.len() <= 8192).then_some(text);
                }
                Ok(read) => {
                    if self.buffer.len() + read > 65536 {
                        self.buffer.clear();
                        continue;
                    }
                    self.buffer.extend_from_slice(&chunk[..read]);
                }
            }
        }
    }
}
