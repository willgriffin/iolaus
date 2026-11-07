# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "huggingface-hub==0.35.3",
#   "torch==2.8.0",
#   "transformers==4.56.2",
# ]
# ///
"""Encode fictional matching inputs with a pinned Apache-2.0 model on CPU."""

import argparse
import base64
import hashlib
import json
import struct
import sys
from pathlib import Path
from time import perf_counter

import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "sentence-transformers/all-MiniLM-L6-v2"
REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
DIMENSIONS = 384
MAX_TOKENS = 256
BATCH_SIZE = 16
ROLES = ("candidate", "opportunity")


def read_inputs(raw):
    records = json.loads(raw)
    if not isinstance(records, list) or not records:
        raise ValueError("expected a nonempty array of embedding inputs")

    seen = set()
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError(f"expected an object at input {index}")
        identifier = record.get("id")
        text = record.get("text")
        if not isinstance(identifier, str) or not identifier.strip():
            raise ValueError(f"expected a nonempty id at input {index}")
        if identifier in seen:
            raise ValueError(f"duplicate id at input {index}")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"expected nonempty text at input {index}")
        if record.get("role") not in ROLES:
            raise ValueError(f"expected candidate or opportunity role at input {index}")
        seen.add(identifier)

    return records


def embed(tokenizer, model, records):
    stats = {}
    vectors = {}
    for role in ROLES:
        group = [record for record in records if record["role"] == role]
        truncated = 0
        started = perf_counter()
        for offset in range(0, len(group), BATCH_SIZE):
            batch = group[offset : offset + BATCH_SIZE]
            texts = [record["text"] for record in batch]
            lengths = tokenizer(
                texts, truncation=False, return_length=True, verbose=False
            )["length"]
            truncated += sum(length > MAX_TOKENS for length in lengths)
            inputs = tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=MAX_TOKENS,
                return_tensors="pt",
            )
            with torch.inference_mode():
                hidden_states = model(**inputs).last_hidden_state
                mask = inputs["attention_mask"].unsqueeze(-1)
                pooled = (hidden_states * mask).sum(dim=1) / mask.sum(dim=1).clamp(
                    min=1
                )
                normalized = torch.nn.functional.normalize(pooled, dim=1)
            for record, vector in zip(batch, normalized.tolist(), strict=True):
                vectors[record["id"]] = vector
        stats[role] = {
            "count": len(group),
            "truncated": truncated,
            "preprocessingMs": round((perf_counter() - started) * 1000, 3),
        }

    return vectors, stats


def write_vectors(path, raw, records, vectors):
    artifact = {
        "model": MODEL,
        "revision": REVISION,
        "dimensions": DIMENSIONS,
        "inputSha256": hashlib.sha256(raw).hexdigest(),
        "vectors": [],
    }
    for record in records:
        identifier = record["id"]
        packed = struct.pack(f"<{DIMENSIONS}f", *vectors[identifier])
        artifact["vectors"].append(
            {"id": identifier, "values": base64.b64encode(packed).decode("ascii")}
        )
    path.write_text(
        json.dumps(artifact, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    raw = args.input.read_bytes()
    try:
        records = read_inputs(raw)
    except ValueError as error:
        parser.error(str(error))

    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)

    started = perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION)
    tokenizer.truncation_side = "right"
    model = AutoModel.from_pretrained(MODEL, revision=REVISION, use_safetensors=True)
    model.to("cpu").eval()
    if model.config.hidden_size != DIMENSIONS:
        raise ValueError(
            f"expected model dimension {DIMENSIONS}, got {model.config.hidden_size}"
        )
    load_ms = round((perf_counter() - started) * 1000, 3)

    vectors, stats = embed(tokenizer, model, records)
    write_vectors(args.output, raw, records, vectors)
    print(
        json.dumps(
            {
                "model": MODEL,
                "revision": REVISION,
                "dimensions": DIMENSIONS,
                "maxTokensIncludingSpecialTokens": MAX_TOKENS,
                "batchSize": BATCH_SIZE,
                "torchThreads": torch.get_num_threads(),
                "torchVersion": torch.__version__,
                "pythonVersion": sys.version.split()[0],
                "modelLoadMs": load_ms,
                "roles": stats,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
