use url::Url;

pub fn validate_init(token: &str, origin: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()) && valid_origin(origin)
}

fn valid_origin(value: &str) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.scheme() == "otools-plugin" {
        return value == "otools-plugin://localhost";
    }
    matches!(url.scheme(), "http" | "https" | "tauri")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && (url.path().is_empty() || url.path() == "/")
        && url.query().is_none()
        && url.fragment().is_none()
        && (value == format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default())
            || url.port().is_some_and(|port| {
                value
                    == format!(
                        "{}://{}:{port}",
                        url.scheme(),
                        url.host_str().unwrap_or_default()
                    )
            }))
}

/// 包内可对外服务的缓存文件名（图片/派生预览），其余一律拒绝。
pub fn safe_cache_name(name: &str) -> bool {
    let valid = name
        .strip_suffix(".jpg")
        .or_else(|| name.strip_suffix(".mp4"))
        .or_else(|| name.strip_suffix(".png"))
        .or_else(|| name.strip_suffix(".qoi"))
        .or_else(|| name.strip_suffix(".json"))
        .or_else(|| name.strip_suffix(".webp"));
    match valid {
        Some(base) => !base.is_empty()
            && base
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        None => false,
    }
}
