// Local sentence-embedding worker. Speaks newline-delimited JSON over stdio,
// mirroring hpm-asr: `init` loads an ONNX embedding model (downloaded to the
// Hugging Face cache on first run), then each `embed` request returns an
// L2-normalized mean-pooled vector. Built for multilingual-e5-small (384 dims),
// which expects "query: " / "passage: " prefixes.

use anyhow::{anyhow, Context, Result};
use hpm_util::{emit, SharedOut};
use serde::Deserialize;
use serde_json::json;
use std::{
    io::{self, BufRead},
    sync::{Arc, Mutex},
};
use tokenizers::{Tokenizer, TruncationParams};

const DEFAULT_MODEL: &str = "multilingual-e5-small";
const DEFAULT_DIM: usize = 384;

struct Model {
    session: ort::session::Session,
    tokenizer: Tokenizer,
    needs_token_type: bool,
    dim: usize,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Init {
        model: Option<String>,
        dim: Option<usize>,
    },
    Embed {
        id: String,
        kind: Option<String>,
        text: String,
    },
    Flush {
        id: Option<String>,
    },
    Shutdown,
}

fn main() -> Result<()> {
    let out: SharedOut = Arc::new(Mutex::new(io::stdout()));
    let mut model: Option<Model> = None;
    let mut model_name = DEFAULT_MODEL.to_string();

    for line in io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(err) => {
                emit(
                    &out,
                    json!({ "type": "error", "message": format!("invalid request: {err}") }),
                );
                continue;
            }
        };

        match req {
            Request::Init {
                model: name,
                dim: requested_dim,
            } => {
                model_name = name.unwrap_or_else(|| DEFAULT_MODEL.to_string());
                let dim = requested_dim.unwrap_or(DEFAULT_DIM);
                emit(
                    &out,
                    json!({ "type": "status", "status": "loading", "engine": engine_name(&model_name), "message": "loading embedding model" }),
                );
                match load_model(&out, &model_name, dim) {
                    Ok(loaded) => {
                        model = Some(loaded);
                        emit(
                            &out,
                            json!({ "type": "ready", "engine": engine_name(&model_name), "model": model_name, "dim": dim }),
                        );
                    }
                    Err(err) => emit(
                        &out,
                        json!({ "type": "error", "engine": engine_name(&model_name), "message": format!("embedding model failed: {err}") }),
                    ),
                }
            }
            Request::Embed { id, kind, text } => {
                let Some(model) = model.as_mut() else {
                    emit(
                        &out,
                        json!({ "type": "error", "id": id, "message": "model not loaded" }),
                    );
                    continue;
                };
                let kind = kind.unwrap_or_else(|| "passage".to_string());
                match embed(model, &kind, &text) {
                    Ok(vector) => emit(
                        &out,
                        json!({ "type": "embedding", "id": id, "kind": kind, "vector": vector }),
                    ),
                    Err(err) => emit(
                        &out,
                        json!({ "type": "error", "id": id, "message": format!("embed failed: {err}") }),
                    ),
                }
            }
            Request::Flush { id } => {
                emit(&out, json!({ "type": "flushed", "id": id }));
            }
            Request::Shutdown => {
                emit(
                    &out,
                    json!({ "type": "status", "status": "stopped", "engine": engine_name(&model_name) }),
                );
                break;
            }
        }
    }

    Ok(())
}

fn load_model(out: &SharedOut, name: &str, dim: usize) -> Result<Model> {
    let repo = hf_repo(name);
    let api = hf_hub::api::sync::Api::new().context("init hf-hub api")?;
    let repo = api.model(repo.to_string());

    let tokenizer_path = match repo.get("tokenizer.json") {
        Ok(path) => path,
        Err(_) => {
            emit(
                out,
                json!({ "type": "status", "status": "downloading", "engine": engine_name(name), "message": "downloading embedding model" }),
            );
            repo.get("tokenizer.json")
                .context("download tokenizer.json")?
        }
    };
    let model_path = repo
        .get("onnx/model.onnx")
        .context("download onnx/model.onnx")?;

    let mut tokenizer =
        Tokenizer::from_file(&tokenizer_path).map_err(|err| anyhow!(err.to_string()))?;
    // Cap sequences at the model's position-embedding table. Without this, a
    // long passage (e.g. a multi-KB transcript) overflows and ONNX trips on the
    // Add node in the embedding layer.
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: max_seq_len(name),
            ..Default::default()
        }))
        .map_err(|err| anyhow!(err.to_string()))?;
    let session = ort::session::Session::builder()
        .context("session builder")?
        .commit_from_file(&model_path)
        .context("load onnx model")?;
    let needs_token_type = session
        .inputs
        .iter()
        .any(|input| input.name == "token_type_ids");

    Ok(Model {
        session,
        tokenizer,
        needs_token_type,
        dim,
    })
}

fn embed(model: &mut Model, kind: &str, text: &str) -> Result<Vec<f32>> {
    let prefix = if kind == "query" {
        "query: "
    } else {
        "passage: "
    };
    let input = format!("{prefix}{text}");
    let encoding = model
        .tokenizer
        .encode(input, true)
        .map_err(|err| anyhow!(err.to_string()))?;

    let ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&m| m as i64)
        .collect();
    let seq = ids.len();
    let shape = [1_i64, seq as i64];

    let id_tensor = ort::value::Tensor::from_array((shape, ids.clone()))?;
    let mask_tensor = ort::value::Tensor::from_array((shape, mask.clone()))?;

    let outputs = if model.needs_token_type {
        let tt_tensor = ort::value::Tensor::from_array((shape, vec![0_i64; seq]))?;
        model.session.run(ort::inputs![
            "input_ids" => id_tensor,
            "attention_mask" => mask_tensor,
            "token_type_ids" => tt_tensor,
        ])?
    } else {
        model.session.run(ort::inputs![
            "input_ids" => id_tensor,
            "attention_mask" => mask_tensor,
        ])?
    };

    let (shape, data) = outputs[0].try_extract_tensor::<f32>()?;
    // last_hidden_state: [1, seq, hidden]
    let hidden = *shape.last().context("empty output shape")? as usize;
    if hidden != model.dim {
        return Err(anyhow!(
            "model hidden size {hidden} does not match configured dim {}",
            model.dim
        ));
    }

    // Mean pool over tokens, weighted by the attention mask, then L2 normalize.
    let mut pooled = vec![0_f32; hidden];
    let mut count = 0_f32;
    for (token, &keep) in mask.iter().enumerate() {
        if keep == 0 {
            continue;
        }
        count += 1.0;
        let base = token * hidden;
        for (h, value) in pooled.iter_mut().enumerate() {
            *value += data[base + h];
        }
    }
    if count == 0.0 {
        count = 1.0;
    }
    for value in pooled.iter_mut() {
        *value /= count;
    }
    let norm = pooled.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in pooled.iter_mut() {
            *value /= norm;
        }
    }
    Ok(pooled)
}

fn hf_repo(model: &str) -> &str {
    match model {
        "multilingual-e5-small" => "Xenova/multilingual-e5-small",
        "bge-small-en-v1.5" => "Xenova/bge-small-en-v1.5",
        "all-MiniLM-L6-v2" => "Xenova/all-MiniLM-L6-v2",
        other => other,
    }
}

fn max_seq_len(model: &str) -> usize {
    match model {
        "all-MiniLM-L6-v2" => 256,
        _ => 512,
    }
}

fn engine_name(model: &str) -> String {
    format!("local:{model}")
}
