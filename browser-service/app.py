# Focus Room browser sidecar — real browser research via browser-use.
#
# The Node app sends the active session provider/model/key with each request.
# Credentials are used in memory for that task only and are never logged.

import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from browser_use import (  # noqa: E402
    Agent,
    Browser,
    ChatGoogle,
    ChatGroq,
    ChatOpenAI,
    ChatOpenRouter,
)

app = FastAPI(title="Focus Room browser sidecar")

CANONICAL_BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
}

BASE_URLS = {
    "openrouter": os.getenv("OPENROUTER_BASE_URL", CANONICAL_BASE_URLS["openrouter"]),
    "groq": os.getenv("GROQ_BASE_URL", CANONICAL_BASE_URLS["groq"]),
    "gemini": os.getenv("GEMINI_BASE_URL", CANONICAL_BASE_URLS["gemini"]),
}

ENV_KEYS = {
    "openrouter": "OPENROUTER_API_KEY",
    "groq": "GROQ_API_KEY",
    # Focus Room uses GEMINI_API_KEY; Browser Use's native Google adapter also
    # accepts an explicit api_key, so no env-var rename is required here.
    "gemini": "GEMINI_API_KEY",
    "custom": "CUSTOM_API_KEY",
}

DEFAULT_MODELS = {
    "openrouter": "openrouter/free",
    "groq": "openai/gpt-oss-120b",
    "gemini": "gemini-2.5-flash",
    "custom": "gpt-4o-mini",
}


class Task(BaseModel):
    instruction: str
    api_key: str | None = None
    model: str | None = None
    base_url: str | None = None
    provider: str | None = None
    # Optional independent free-tier route supplied by the Node fallback layer.
    # Browser Use switches to it on auth/payment/rate/server failures.
    fallback_api_key: str | None = None
    fallback_model: str | None = None
    fallback_base_url: str | None = None
    fallback_provider: str | None = None


def package_version() -> str:
    try:
        return version("browser-use")
    except PackageNotFoundError:
        return "unknown"


def build_llm(provider: str, model: str, api_key: str, base_url: str | None = None):
    """Use Browser Use's native adapters where possible.

    Native adapters understand provider-specific tool-calling quirks better than
    pretending every service is OpenAI. A custom/overridden endpoint still uses
    the generic OpenAI-compatible adapter.
    """

    canonical_url = CANONICAL_BASE_URLS.get(provider, "")
    # A provider endpoint override is usually a gateway/proxy. Native adapters
    # hard-code their provider endpoint, so use the generic OpenAI-compatible
    # adapter when an override is present to make the override actually work.
    if provider == "custom" or (base_url and canonical_url and base_url.rstrip("/") != canonical_url.rstrip("/")):
        if not base_url:
            raise ValueError("A custom provider needs a base URL.")
        return ChatOpenAI(model=model, api_key=api_key, base_url=base_url)

    if provider == "openrouter":
        return ChatOpenRouter(model=model, api_key=api_key)
    if provider == "groq":
        return ChatGroq(model=model, api_key=api_key)
    if provider == "gemini":
        return ChatGoogle(model=model, api_key=api_key)

    # Unknown provider IDs can still work if they supplied an OpenAI-compatible
    # base URL explicitly.
    if base_url:
        return ChatOpenAI(model=model, api_key=api_key, base_url=base_url)
    raise ValueError(f"Unsupported browser provider: {provider}")


@app.get("/health")
def health():
    return {"ok": True, "engine": "browser-use", "version": package_version()}


@app.post("/task")
async def run_task(task: Task):
    provider = (task.provider or "openrouter").lower()
    env_name = ENV_KEYS.get(provider, "OPENROUTER_API_KEY")
    api_key = task.api_key or os.getenv(env_name)
    if not api_key:
        raise HTTPException(
            400,
            f"No {provider} API key supplied. Add one in Focus Room settings or set {env_name}.",
        )

    model = task.model or os.getenv("BROWSER_MODEL") or DEFAULT_MODELS.get(provider, "openrouter/free")
    base_url = task.base_url or BASE_URLS.get(provider)

    try:
        llm = build_llm(provider, model, api_key, base_url)
        fallback_llm = None
        # Browser Use can switch LLMs inside one browser run on 401/402/429/5xx.
        # Prefer the Node layer's independent provider route when available; it
        # survives account-level quotas better than another model on one key.
        if task.fallback_api_key and task.fallback_provider and task.fallback_model:
            fallback_provider = task.fallback_provider.lower()
            fallback_url = task.fallback_base_url or BASE_URLS.get(fallback_provider)
            fallback_llm = build_llm(
                fallback_provider,
                task.fallback_model,
                task.fallback_api_key,
                fallback_url,
            )
        elif provider == "openrouter" and model != "openrouter/free":
            fallback_llm = build_llm("openrouter", "openrouter/free", api_key, BASE_URLS["openrouter"])
    except Exception as exc:
        raise HTTPException(400, f"Could not configure browser model: {exc}") from exc

    # Current Browser Use accepts browser settings directly on Browser(). The
    # old Browser(browser_profile=BrowserProfile(...)) shape is no longer the
    # documented construction path.
    browser = Browser(headless=True)
    agent = Agent(
        task=task.instruction,
        llm=llm,
        fallback_llm=fallback_llm,
        browser=browser,
        # Research is primarily textual. Disabling vision and thinking saves
        # tokens/requests on free tiers; Browser Use can still inspect the DOM.
        use_vision=False,
        flash_mode=True,
        max_failures=2,
        llm_timeout=int(os.getenv("BROWSER_LLM_TIMEOUT", "60")),
        step_timeout=int(os.getenv("BROWSER_STEP_TIMEOUT", "90")),
    )

    try:
        history = await agent.run(max_steps=int(os.getenv("BROWSER_MAX_STEPS", "12")))
        result = history.final_result()
        if not result:
            raise RuntimeError("browser agent finished without an extracted result")
        return {
            "result": result,
            "steps": history.number_of_steps(),
            "success": history.is_successful(),
            "version": package_version(),
        }
    except Exception as exc:
        raise HTTPException(502, f"browser agent failed: {exc}") from exc
    finally:
        # Browser Use does not guarantee that an explicitly managed Browser is
        # stopped when Agent.run() exits. Always release Chromium here.
        try:
            await browser.stop()
        except Exception:
            pass
