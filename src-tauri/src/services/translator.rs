use serde_json::json;
use futures::StreamExt;
use crate::app_config::AppType;
use crate::error::AppError;
use crate::proxy::providers::{get_adapter, AuthInfo};
use crate::store::AppState;

pub struct TranslatorService;

impl TranslatorService {
    fn truncate_for_log(text: &str, max_chars: usize) -> String {
        let mut out = text.chars().take(max_chars).collect::<String>();
        if text.chars().count() > max_chars {
            out.push_str("...(truncated)");
        }
        out
    }

    fn resolve_model_from_provider(
        app_type: &AppType,
        provider: &crate::provider::Provider,
        fallback: &str,
    ) -> String {
        let cfg = &provider.settings_config;
        let get_str = |key: &str| cfg.get(key).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty());
        let get_env_str = |key: &str| {
            cfg.get("env")
                .and_then(|v| v.get(key))
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
        };
        match app_type {
            AppType::Claude => get_env_str("ANTHROPIC_MODEL")
                .or_else(|| get_str("model"))
                .or_else(|| get_str("sonnetModel"))
                .or_else(|| get_str("haikuModel"))
                .or_else(|| get_str("opusModel"))
                .unwrap_or(fallback)
                .to_string(),
            AppType::Gemini | AppType::Codex => get_str("model").unwrap_or(fallback).to_string(),
            _ => fallback.to_string(),
        }
    }
    /// 翻译文本
    pub async fn translate(
        state: &AppState,
        text: &str,
        target_lang: &str,
    ) -> Result<String, AppError> {
        Self::translate_with_fallback(state, text, target_lang, None).await
    }

    pub async fn translate_stream<F>(
        state: &AppState,
        text: &str,
        target_lang: &str,
        app_type: &AppType,
        provider_id: &str,
        model_override: Option<&str>,
        mut on_chunk: F,
    ) -> Result<(), AppError>
    where
        F: FnMut(String) -> Result<(), AppError>,
    {
        let provider = state
            .db
            .get_provider_by_id(provider_id, app_type.as_str())
            .map_err(|e| AppError::Message(format!("读取 provider 详情失败: {e}")))?
            .ok_or_else(|| AppError::Message(format!("provider 不存在: {provider_id}")))?;
        Self::translate_with_provider_stream(
            app_type,
            provider,
            text,
            target_lang,
            model_override,
            &mut on_chunk,
        )
        .await
    }

    async fn translate_with_fallback(
        state: &AppState,
        text: &str,
        target_lang: &str,
        model_override: Option<&str>,
    ) -> Result<String, AppError> {
        let app_types = [AppType::Gemini, AppType::Claude, AppType::Codex];
        let mut last_error = None;
        for app_type in app_types {
            let provider_id = match state.db.get_current_provider(app_type.as_str()) {
                Ok(Some(id)) => id,
                _ => continue,
            };
            let provider = match state.db.get_provider_by_id(&provider_id, app_type.as_str()) {
                Ok(Some(p)) => p,
                _ => continue,
            };
            match Self::translate_with_provider(
                &app_type,
                provider,
                text,
                target_lang,
                model_override,
            )
            .await
            {
                Ok(translated) => return Ok(translated),
                Err(e) => {
                    log::warn!("翻译失败 ({}): {}", app_type.as_str(), e);
                    last_error = Some(e);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| AppError::Message("没有可用的翻译供应商".to_string())))
    }

    async fn translate_with_provider(
        app_type: &AppType,
        provider: crate::provider::Provider,
        text: &str,
        target_lang: &str,
        model_override: Option<&str>,
    ) -> Result<String, AppError> {
        let provider_id = provider.id.clone();
        let provider_name = provider.name.clone();
        let adapter = get_adapter(&app_type);
        let base_url = adapter.extract_base_url(&provider)
            .map_err(|e| AppError::Message(format!("无法提取基础 URL: {e}")))?;
        let auth = adapter.extract_auth(&provider)
            .ok_or_else(|| AppError::Message("未找到 API Key".to_string()))?;

        let client = crate::proxy::http_client::get();
        let fallback_model = match app_type {
            AppType::Gemini => "gemini-1.5-flash", // 翻译场景使用 flash 足够且快
            AppType::Claude => "claude-3-haiku-20240307",
            AppType::Codex => "gpt-4o-mini",
            _ => return Err(AppError::Message("不支持的翻译应用类型".to_string())),
        };
        let resolved_model = Self::resolve_model_from_provider(app_type, &provider, fallback_model);
        let model = model_override.unwrap_or(resolved_model.as_str());
        log::info!(
            "[Translator] translate start app={} provider={}({}) model={} target_lang={} text_len={} base_url={}",
            app_type.as_str(),
            provider_name,
            provider_id,
            model,
            target_lang,
            text.len(),
            base_url
        );

        let system_prompt = format!(
            "You are a professional translator. Translate the following text to {}. \
            Maintain the original Markdown formatting and technical terms. \
            Only output the translated text, nothing else.",
            target_lang
        );

        match app_type {
            AppType::Gemini => Self::call_gemini(&client, &base_url, &auth, model, &system_prompt, text).await,
            AppType::Claude | AppType::Codex => {
                // 默认优先使用 Claude 协议；若服务端不支持，再回退到 OpenAI 兼容协议
                match Self::call_claude_compatible(
                    &client,
                    &base_url,
                    &auth,
                    model,
                    &system_prompt,
                    text,
                )
                .await
                {
                    Ok(translated) => Ok(translated),
                    Err(claude_err) => {
                        log::warn!(
                            "[Translator] Claude protocol failed app={} provider={}({}) model={} err={}",
                            app_type.as_str(),
                            provider_name,
                            provider_id,
                            model,
                            claude_err
                        );
                        Self::call_openai_compatible(
                            &client,
                            &base_url,
                            &auth,
                            model,
                            &system_prompt,
                            text,
                        )
                        .await
                    }
                }
            }
            _ => Err(AppError::Message("不支持的翻译应用类型".to_string())),
        }
    }

    async fn translate_with_provider_stream<F>(
        app_type: &AppType,
        provider: crate::provider::Provider,
        text: &str,
        target_lang: &str,
        model_override: Option<&str>,
        on_chunk: &mut F,
    ) -> Result<(), AppError>
    where
        F: FnMut(String) -> Result<(), AppError>,
    {
        let provider_id = provider.id.clone();
        let provider_name = provider.name.clone();
        let adapter = get_adapter(app_type);
        let base_url = adapter.extract_base_url(&provider)
            .map_err(|e| AppError::Message(format!("无法提取基础 URL: {e}")))?;
        let auth = adapter.extract_auth(&provider)
            .ok_or_else(|| AppError::Message("未找到 API Key".to_string()))?;
        let client = crate::proxy::http_client::get();
        let fallback_model = match app_type {
            AppType::Gemini => "gemini-1.5-flash",
            AppType::Claude => "claude-3-haiku-20240307",
            AppType::Codex => "gpt-4o-mini",
            _ => return Err(AppError::Message("不支持的翻译应用类型".to_string())),
        };
        let resolved_model = Self::resolve_model_from_provider(app_type, &provider, fallback_model);
        let model = model_override.unwrap_or(resolved_model.as_str());
        log::info!(
            "[Translator] stream start app={} provider={}({}) model={} target_lang={} text_len={} base_url={}",
            app_type.as_str(),
            provider_name,
            provider_id,
            model,
            target_lang,
            text.len(),
            base_url
        );
        let system_prompt = format!(
            "You are a professional translator. Translate the following text to {}. \
            Maintain the original Markdown formatting and technical terms. \
            Only output the translated text, nothing else.",
            target_lang
        );
        match app_type {
            AppType::Gemini => {
                Self::call_gemini_stream(&client, &base_url, &auth, model, &system_prompt, text, on_chunk).await
            }
            AppType::Claude | AppType::Codex => {
                // 默认优先使用 Claude 协议流式；失败后回退 OpenAI 兼容协议流式
                match Self::call_claude_compatible_stream(
                    &client,
                    &base_url,
                    &auth,
                    model,
                    &system_prompt,
                    text,
                    on_chunk,
                )
                .await
                {
                    Ok(()) => Ok(()),
                    Err(claude_err) => {
                        log::warn!(
                            "[Translator] Claude stream failed app={} provider={}({}) model={} err={}",
                            app_type.as_str(),
                            provider_name,
                            provider_id,
                            model,
                            claude_err
                        );
                        Self::call_openai_compatible_stream(
                            &client,
                            &base_url,
                            &auth,
                            model,
                            &system_prompt,
                            text,
                            on_chunk,
                        )
                        .await
                    }
                }
            }
            _ => Err(AppError::Message("不支持的翻译应用类型".to_string())),
        }
    }

    async fn call_claude_compatible(
        client: &reqwest::Client,
        base_url: &str,
        auth: &AuthInfo,
        model: &str,
        system_prompt: &str,
        text: &str,
    ) -> Result<String, AppError> {
        let base = base_url.trim_end_matches('/');
        let url = if base.ends_with("/messages") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/messages")
        } else {
            format!("{base}/v1/messages")
        };

        let body = json!({
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [
                { "role": "user", "content": text }
            ],
            "stream": false
        });
        log::debug!(
            "[Translator] Claude request url={} model={} body_preview={}",
            url,
            model,
            Self::truncate_for_log(&body.to_string(), 600)
        );

        let resp = client
            .post(&url)
            .header("x-api-key", &auth.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Message(format!("Claude 协议请求失败: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            log::error!(
                "[Translator] Claude failed status={} url={} body={}",
                status,
                url,
                Self::truncate_for_log(&err_text, 1200)
            );
            return Err(AppError::Message(format!("Claude 协议翻译失败 ({}): {}", status, err_text)));
        }

        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Message(format!("解析 Claude 协议响应失败: {e}")))?;

        let translated = json["content"]
            .as_array()
            .and_then(|arr| {
                arr.iter().find_map(|item| {
                    if item["type"].as_str() == Some("text") {
                        item["text"].as_str()
                    } else {
                        None
                    }
                })
            })
            .ok_or_else(|| AppError::Message("Claude 协议返回内容格式不正确".to_string()))?;

        Ok(translated.to_string())
    }

    async fn call_gemini(
        client: &reqwest::Client,
        base_url: &str,
        auth: &AuthInfo,
        model: &str,
        system_prompt: &str,
        text: &str,
    ) -> Result<String, AppError> {
        let base = base_url.trim_end_matches('/');
        let url = if base.contains("/v1beta") || base.contains("/v1/") {
            format!("{base}/models/{model}:generateContent")
        } else {
            format!("{base}/v1beta/models/{model}:generateContent")
        };

        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [{ "text": format!("{}\n\nText to translate:\n{}", system_prompt, text) }]
            }]
        });

        let resp = client.post(&url)
            .header("x-goog-api-key", &auth.api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Message(format!("Gemini 请求失败: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(AppError::Message(format!("Gemini 翻译失败 ({}): {}", status, err_text)));
        }

        let json: serde_json::Value = resp.json().await
            .map_err(|e| AppError::Message(format!("解析 Gemini 响应失败: {e}")))?;

        let translated = json["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .ok_or_else(|| AppError::Message("Gemini 返回内容格式不正确".to_string()))?;

        Ok(translated.to_string())
    }

    async fn call_openai_compatible(
        client: &reqwest::Client,
        base_url: &str,
        auth: &AuthInfo,
        model: &str,
        system_prompt: &str,
        text: &str,
    ) -> Result<String, AppError> {
        let base = base_url.trim_end_matches('/');
        let url = if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        };

        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": text }
            ],
            "stream": false
        });
        log::debug!(
            "[Translator] OpenAI-compatible request url={} model={} body_preview={}",
            url,
            model,
            Self::truncate_for_log(&body.to_string(), 600)
        );

        let resp = client.post(&url)
            .header("Authorization", format!("Bearer {}", auth.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Message(format!("LLM 请求失败: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            log::error!(
                "[Translator] OpenAI-compatible failed status={} url={} body={}",
                status,
                url,
                Self::truncate_for_log(&err_text, 1200)
            );
            return Err(AppError::Message(format!("翻译失败 ({}): {}", status, err_text)));
        }

        let json: serde_json::Value = resp.json().await
            .map_err(|e| AppError::Message(format!("解析 LLM 响应失败: {e}")))?;

        let translated = json["choices"][0]["message"]["content"]
            .as_str()
            .ok_or_else(|| AppError::Message("LLM 返回内容格式不正确".to_string()))?;

        Ok(translated.to_string())
    }

    async fn call_openai_compatible_stream<F>(
        client: &reqwest::Client,
        base_url: &str,
        auth: &AuthInfo,
        model: &str,
        system_prompt: &str,
        text: &str,
        on_chunk: &mut F,
    ) -> Result<(), AppError>
    where
        F: FnMut(String) -> Result<(), AppError>,
    {
        let base = base_url.trim_end_matches('/');
        let url = if base.ends_with("/chat/completions") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/chat/completions")
        } else {
            format!("{base}/v1/chat/completions")
        };
        let body = json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": text }
            ],
            "stream": true
        });
        log::debug!(
            "[Translator] OpenAI-compatible stream request url={} model={} body_preview={}",
            url,
            model,
            Self::truncate_for_log(&body.to_string(), 600)
        );
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", auth.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Message(format!("LLM 流式请求失败: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            log::error!(
                "[Translator] OpenAI-compatible stream failed status={} url={} body={}",
                status,
                url,
                Self::truncate_for_log(&err_text, 1200)
            );
            return Err(AppError::Message(format!("翻译失败 ({}): {}", status, err_text)));
        }
        let mut stream = resp.bytes_stream();
        let mut pending = String::new();
        while let Some(item) = stream.next().await {
            let bytes = item.map_err(|e| AppError::Message(format!("读取流失败: {e}")))?;
            pending.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(idx) = pending.find('\n') {
                let line = pending[..idx].trim().to_string();
                pending = pending[idx + 1..].to_string();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line.trim_start_matches("data:").trim();
                if data == "[DONE]" || data.is_empty() {
                    continue;
                }
                let json: serde_json::Value = serde_json::from_str(data)
                    .map_err(|e| AppError::Message(format!("解析流式响应失败: {e}")))?;
                if let Some(delta) = json["choices"][0]["delta"]["content"].as_str() {
                    on_chunk(delta.to_string())?;
                }
            }
        }
        Ok(())
    }

    async fn call_claude_compatible_stream<F>(
        client: &reqwest::Client,
        base_url: &str,
        auth: &AuthInfo,
        model: &str,
        system_prompt: &str,
        text: &str,
        on_chunk: &mut F,
    ) -> Result<(), AppError>
    where
        F: FnMut(String) -> Result<(), AppError>,
    {
        let base = base_url.trim_end_matches('/');
        let url = if base.ends_with("/messages") {
            base.to_string()
        } else if base.ends_with("/v1") {
            format!("{base}/messages")
        } else {
            format!("{base}/v1/messages")
        };

        let body = json!({
            "model": model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": [
                { "role": "user", "content": text }
            ],
            "stream": true
        });
        log::debug!(
            "[Translator] Claude stream request url={} model={} body_preview={}",
            url,
            model,
            Self::truncate_for_log(&body.to_string(), 600)
        );

        let resp = client
            .post(&url)
            .header("x-api-key", &auth.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Message(format!("Claude 协议流式请求失败: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            log::error!(
                "[Translator] Claude stream failed status={} url={} body={}",
                status,
                url,
                Self::truncate_for_log(&err_text, 1200)
            );
            return Err(AppError::Message(format!("Claude 协议翻译失败 ({}): {}", status, err_text)));
        }

        let mut stream = resp.bytes_stream();
        let mut pending = String::new();
        while let Some(item) = stream.next().await {
            let bytes = item.map_err(|e| AppError::Message(format!("读取 Claude 流失败: {e}")))?;
            pending.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(idx) = pending.find('\n') {
                let line = pending[..idx].trim().to_string();
                pending = pending[idx + 1..].to_string();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line.trim_start_matches("data:").trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let json: serde_json::Value = serde_json::from_str(data)
                    .map_err(|e| AppError::Message(format!("解析 Claude 流式响应失败: {e}")))?;
                if json["type"].as_str() == Some("content_block_delta")
                    && json["delta"]["type"].as_str() == Some("text_delta")
                {
                    if let Some(delta) = json["delta"]["text"].as_str() {
                        on_chunk(delta.to_string())?;
                    }
                }
            }
        }
        Ok(())
    }

    async fn call_gemini_stream<F>(
        client: &reqwest::Client,
        base_url: &str,
        auth: &AuthInfo,
        model: &str,
        system_prompt: &str,
        text: &str,
        on_chunk: &mut F,
    ) -> Result<(), AppError>
    where
        F: FnMut(String) -> Result<(), AppError>,
    {
        let base = base_url.trim_end_matches('/');
        let url = if base.contains("/v1beta") || base.contains("/v1/") {
            format!("{base}/models/{model}:streamGenerateContent?alt=sse")
        } else {
            format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse")
        };
        let body = json!({
            "contents": [{
                "role": "user",
                "parts": [{ "text": format!("{}\n\nText to translate:\n{}", system_prompt, text) }]
            }]
        });
        let resp = client
            .post(&url)
            .header("x-goog-api-key", &auth.api_key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Message(format!("Gemini 流式请求失败: {e}")))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await.unwrap_or_default();
            return Err(AppError::Message(format!("Gemini 翻译失败 ({}): {}", status, err_text)));
        }
        let mut stream = resp.bytes_stream();
        let mut pending = String::new();
        while let Some(item) = stream.next().await {
            let bytes = item.map_err(|e| AppError::Message(format!("读取 Gemini 流失败: {e}")))?;
            pending.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(idx) = pending.find('\n') {
                let line = pending[..idx].trim().to_string();
                pending = pending[idx + 1..].to_string();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line.trim_start_matches("data:").trim();
                if data.is_empty() {
                    continue;
                }
                let json: serde_json::Value = serde_json::from_str(data)
                    .map_err(|e| AppError::Message(format!("解析 Gemini 流式响应失败: {e}")))?;
                if let Some(delta) = json["candidates"][0]["content"]["parts"][0]["text"].as_str() {
                    on_chunk(delta.to_string())?;
                }
            }
        }
        Ok(())
    }
}
