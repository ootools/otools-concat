use crate::process::{FORMAT_WHITELIST, capture, local_command};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub id: u32,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub codec: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    #[serde(skip)]
    pub path: Option<String>,
    pub name: String,
    pub duration: f64,
    pub kind: String,
    pub video_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    pub audio_tracks: Vec<AudioTrack>,
    #[serde(skip)]
    pub pixel_format: Option<String>,
    #[serde(skip)]
    pub video_index: Option<u32>,
    #[serde(skip)]
    pub source_start: f64,
    #[serde(skip)]
    pub container: String,
}

pub async fn probe_with_cancel(
    ffprobe: &str,
    input: &str,
    shutdown: &CancellationToken,
) -> Result<(PathBuf, MediaInfo), String> {
    let canonical = local_file(input).await?;
    if !allowed_extension(&canonical) {
        return Err("unsupported local media file".into());
    }
    let mut command = local_command(ffprobe);
    command.args(["-v", "error", "-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST,
        "-probesize", "8388608", "-analyzeduration", "10000000", "-max_alloc", "67108864", "-show_format", "-show_streams",
        "-show_entries", "format=format_name,duration,start_time:stream=index,codec_type,codec_name,width,height,pix_fmt,duration,start_time,r_frame_rate,color_transfer:stream_tags=language,title:stream_disposition=attached_pic", "-of", "json"])
        .arg(&canonical);
    let output = capture(command, 1024 * 1024, Duration::from_secs(15), shutdown).await?;
    let json: Value =
        serde_json::from_slice(&output).map_err(|_| "media probe failed".to_owned())?;
    let format = json
        .pointer("/format/format_name")
        .and_then(Value::as_str)
        .ok_or("unsupported media container")?;
    if !format
        .split(',')
        .any(|name| FORMAT_WHITELIST.split(',').any(|allowed| allowed == name))
    {
        return Err("unsupported media container".into());
    }
    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .ok_or("media has no streams")?;
    if streams.len() > 128 {
        return Err("media has too many streams".into());
    }
    let video = streams.iter().find(|stream| {
        stream.get("codec_type").and_then(Value::as_str) == Some("video")
            && stream
                .pointer("/disposition/attached_pic")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                == 0
    });
    let audio_tracks: Vec<AudioTrack> = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .map(|stream| {
            let id = stream.get("index").and_then(Value::as_u64).unwrap_or(0) as u32;
            let codec = stream
                .get("codec_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let language = stream
                .pointer("/tags/language")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let label = stream
                .pointer("/tags/title")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| language.clone())
                .unwrap_or_else(|| format!("Audio {}", id + 1));
            AudioTrack {
                id,
                label,
                language,
                codec,
            }
        })
        .collect();
    if video.is_none() && audio_tracks.is_empty() {
        return Err("media has no playable streams".into());
    }
    // 纯音频文件在 format.duration 缺失时会回退到流时长；图片没有时长，前端按静态素材处理。
    let duration = json
        .pointer("/format/duration")
        .and_then(number_string)
        .or_else(|| {
            streams
                .iter()
                .filter_map(|stream| stream.get("duration").and_then(number_string))
                .reduce(f64::max)
        })
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .unwrap_or(0.0);
    let source_start = json
        .pointer("/format/start_time")
        .and_then(number_string)
        .filter(|start| start.is_finite())
        .unwrap_or(0.0);
    let container = format.to_owned();
    let kind = if video.is_some() {
        "video"
    } else if !audio_tracks.is_empty() {
        "audio"
    } else {
        "image"
    };
    let fps = video
        .and_then(|stream| stream.get("r_frame_rate"))
        .and_then(Value::as_str)
        .and_then(rational)
        .filter(|value| value.is_finite() && *value > 0.0);
    let info = MediaInfo {
        path: Some(canonical.to_string_lossy().into_owned()),
        name: canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("media")
            .to_owned(),
        duration,
        kind: kind.to_owned(),
        video_codec: video
            .and_then(|stream| stream.get("codec_name"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        width: video
            .and_then(|stream| stream.get("width"))
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        height: video
            .and_then(|stream| stream.get("height"))
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        fps,
        has_audio: !audio_tracks.is_empty(),
        audio_tracks,
        pixel_format: video
            .and_then(|stream| stream.get("pix_fmt"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        video_index: video
            .and_then(|stream| stream.get("index"))
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        source_start,
        container,
    };
    Ok((canonical, info))
}

pub async fn local_file(input: &str) -> Result<PathBuf, String> {
    if input.is_empty()
        || input.len() > 32768
        || input.contains('\0')
        || !Path::new(input).is_absolute()
    {
        return Err("only absolute local files are supported".into());
    }
    let canonical = tokio::fs::canonicalize(input)
        .await
        .map_err(|_| "media file cannot be opened".to_owned())?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|_| "media file cannot be opened".to_owned())?;
    if !metadata.is_file() {
        return Err("only regular local files are supported".into());
    }
    Ok(canonical)
}

fn number_string(value: &Value) -> Option<f64> {
    value
        .as_str()
        .and_then(|text| text.parse::<f64>().ok())
        .or_else(|| value.as_f64())
}

fn rational(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator: f64 = numerator.parse().ok()?;
    let denominator: f64 = denominator.parse().ok()?;
    (denominator != 0.0).then(|| numerator / denominator)
}

fn allowed_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp4"
            | "m4v"
            | "mov"
            | "mkv"
            | "webm"
            | "avi"
            | "mpg"
            | "mpeg"
            | "ts"
            | "m2ts"
            | "mts"
            | "mp3"
            | "m4a"
            | "aac"
            | "flac"
            | "wav"
            | "ogg"
            | "opus"
            | "3gp"
            | "ogv"
            | "jpg"
            | "jpeg"
    )
}

/// 视频编码是否是 WebView 可以直接解码的组合（h264 8-bit，无 HDR）。
pub fn compatible_video(info: &MediaInfo) -> bool {
    info.video_codec.is_none()
        || (info.video_codec.as_deref() == Some("h264")
            && matches!(info.pixel_format.as_deref(), Some("yuv420p" | "yuvj420p"))
            && info.fps.is_some_and(|fps| fps <= 120.0))
}

/// 音频编码是否可以直接进浏览器（AAC）。
pub fn compatible_audio(info: &MediaInfo) -> bool {
    info.audio_tracks
        .iter()
        .all(|track| track.codec == "aac" || track.codec.is_empty())
}

/// 预览通道决策：browser（原样）→ remux（换容器）→ proxy（转码）。
/// 图片直接交给 <img>；音频按容器判断（mp3/wav/flac/m4a 浏览器可播）。
pub fn preview_mode(info: &MediaInfo) -> &'static str {
    if info.kind == "image" {
        return "browser";
    }
    let video_ok = info.video_codec.is_none() || compatible_video(info);
    let audio_ok = compatible_audio(info);
    let container_ok = info
        .container
        .split(',')
        .any(|name| matches!(name.trim(), "mov" | "mp4" | "m4v" | "webm" | "mp3" | "aac" | "wav" | "flac"));
    if video_ok && audio_ok && container_ok {
        "browser"
    } else if video_ok && audio_ok {
        "remux"
    } else {
        "proxy"
    }
}

pub fn media_id(path: &Path) -> String {
    // 稳定 ID：规范路径 SHA256 前 16 位 hex（缓存文件名跨重启可复用）。
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    let mut id = String::new();
    for byte in digest.iter().take(8) {
        let _ = write!(id, "{byte:02x}");
    }
    id
}

/// 缩略图：ffmpeg 单帧 JPEG。失败返回错误（前端回退到占位图）。
pub async fn thumbnail(
    ffmpeg: &str,
    path: &Path,
    at_seconds: f64,
    shutdown: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let mut command = local_command(ffmpeg);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            FORMAT_WHITELIST,
            "-ss",
            &format!("{at_seconds:.3}"),
            "-i",
        ])
        .arg(path)
        .args(["-frames:v", "1", "-vf", "scale=240:-2", "-f", "image2", "-c:v", "mjpeg", "-q:v", "6", "pipe:1"]);
    capture(command, 2 * 1024 * 1024, Duration::from_secs(20), shutdown).await
}

/// 音频波形峰值：解码为单声道 s16 8k，采样到 ~2000 个峰值的 RMS 包络。
pub async fn audio_peaks(
    ffmpeg: &str,
    path: &Path,
    shutdown: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let mut command = local_command(ffmpeg);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            FORMAT_WHITELIST,
            "-i",
        ])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "8000",
            "-f",
            "s16le",
            "pipe:1",
        ]);
    let pcm = capture(command, 96 * 1024 * 1024, Duration::from_secs(90), shutdown).await?;
    let samples: Vec<i16> = pcm
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let target = 2000usize;
    if samples.len() <= target {
        return Ok(samples
            .iter()
            .map(|sample| sample.unsigned_abs().min(u8::MAX as u16) as u8)
            .collect::<Vec<u8>>());
    }
    let bucket = samples.len() / target;
    let mut peaks = Vec::with_capacity(target);
    for chunk in samples.chunks(bucket) {
        let sum: u64 = chunk
            .iter()
            .map(|sample| u64::from(sample.unsigned_abs()) * u64::from(sample.unsigned_abs()))
            .sum();
        let rms = ((sum / chunk.len().max(1) as u64) as f64).sqrt().round() as u8;
        peaks.push(rms.min(255));
    }
    Ok(peaks)
}
