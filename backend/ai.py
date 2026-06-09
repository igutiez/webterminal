"""Configuración y llamadas a modelos por API para MessorTerminal.

Proveedores OpenAI-compatibles (de momento Kimi/Moonshot y DeepSeek). La clave de
cada proveedor se guarda en el servidor (ai_config.json, gitignored) y NUNCA se
devuelve en claro a la UI. Las peticiones HTTP usan urllib (stdlib, sin dependencias).
"""
import json
import os
import urllib.error
import urllib.request

CONFIG_PATH = os.environ.get(
    "WEBTERMINAL_AI_CONFIG", os.path.join(os.path.dirname(__file__), "ai_config.json")
)

# Proveedores soportados con valores por defecto (base_url + modelo, editables).
DEFAULTS = {
    "deepseek": {"base_url": "https://api.deepseek.com", "model": "deepseek-chat"},
    "kimi": {"base_url": "https://api.moonshot.ai/v1", "model": "moonshot-v1-32k"},
}

SYSTEM_PROMPT = (
    "Eres un editor de textos meticuloso. Aplica EXACTAMENTE la instrucción del "
    "usuario sobre el texto dado y devuelve ÚNICAMENTE el texto resultante, sin "
    "explicaciones, sin comillas envolventes y sin bloques de código markdown. "
    "Conserva el idioma, el tono y el formato salvo que la instrucción pida lo contrario."
)


def _load() -> dict:
    try:
        with open(CONFIG_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return {}


def _save(data: dict) -> None:
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


def get_provider(name: str):
    """Config completa (CON api_key) mezclando defaults. None si no existe."""
    name = (name or "").lower()
    if name not in DEFAULTS:
        return None
    stored = _load().get(name, {})
    return {
        "base_url": stored.get("base_url") or DEFAULTS[name]["base_url"],
        "model": stored.get("model") or DEFAULTS[name]["model"],
        "api_key": stored.get("api_key") or "",
    }


def public_config() -> dict:
    """Config para la UI: SIN clave en claro, solo si está puesta (has_key)."""
    data = _load()
    out = {}
    for name, d in DEFAULTS.items():
        stored = data.get(name, {})
        out[name] = {
            "base_url": stored.get("base_url") or d["base_url"],
            "model": stored.get("model") or d["model"],
            "has_key": bool(stored.get("api_key")),
        }
    return out


def set_provider(name, api_key, base_url, model) -> bool:
    name = (name or "").lower()
    if name not in DEFAULTS:
        return False
    data = _load()
    prov = data.get(name, {})
    if base_url is not None and base_url.strip():
        prov["base_url"] = base_url.strip()
    if model is not None and model.strip():
        prov["model"] = model.strip()
    if api_key:  # solo se cambia si mandan clave nueva (vacío = no tocar)
        prov["api_key"] = api_key.strip()
    data[name] = prov
    _save(data)
    return True


def complete(name: str, instruction: str, text: str) -> str:
    """Llama al chat-completions del proveedor y devuelve el texto resultante."""
    cfg = get_provider(name)
    if cfg is None:
        raise ValueError("proveedor desconocido")
    if not cfg["api_key"]:
        raise ValueError("falta la API key de ese proveedor (configúrala con ⚙)")
    body = json.dumps({
        "model": cfg["model"],
        "temperature": 0.3,
        "stream": False,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Instrucción:\n{instruction}\n\nTexto:\n{text}"},
        ],
    }).encode("utf-8")
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg["api_key"],
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"{e.code} del proveedor: {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"no se pudo contactar con el proveedor: {e.reason}")
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("respuesta inesperada del proveedor")
