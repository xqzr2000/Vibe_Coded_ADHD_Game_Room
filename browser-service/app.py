# Focus Room browser sidecar — gives Scout a real headless browser via
# browser-use (https://github.com/browser-use/browser-use).
#
# Run:  npm run browser   (from the repo root; keep it running in a 2nd terminal)
# API:  POST /task {"instruction": "..."} -> {"result": "..."}
#
# Uses the same OPENROUTER_API_KEY as the Node app (loaded from the repo
# root .env), so one key powers everything.

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Load the repo-root .env so the sidecar shares config with the Node app.
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from browser_use import Agent, Browser, ChatOpenAI  # noqa: E402
from browser_use.browser.profile import BrowserProfile  # noqa: E402

app = FastAPI(title="Focus Room browser sidecar")


class Task(BaseModel):
    instruction: str


@app.get("/health")
def health():
    return {"ok": True, "engine": "browser-use"}


@app.post("/task")
async def run_task(task: Task):
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise HTTPException(500, "OPENROUTER_API_KEY is not set (repo root .env or environment).")

    llm = ChatOpenAI(
        model=os.getenv("BROWSER_MODEL", "openai/gpt-4o-mini"),
        api_key=api_key,
        base_url="https://openrouter.ai/api/v1",
    )
    browser = Browser(browser_profile=BrowserProfile(headless=True))

    agent = Agent(task=task.instruction, llm=llm, browser=browser)
    try:
        history = await agent.run(max_steps=int(os.getenv("BROWSER_MAX_STEPS", "20")))
    except Exception as exc:  # surface browser/agent failures to the caller
        raise HTTPException(502, f"browser agent failed: {exc}") from exc

    result = history.final_result()
    return {"result": result or "The browser agent finished without an extracted result."}
