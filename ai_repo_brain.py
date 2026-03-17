#!/usr/bin/env python3

import os
import re
from pathlib import Path

ROOT = Path(".")
AI_DIR = ROOT / ".ai_repo"

IGNORE_DIRS = {
    ".git","node_modules",".next","dist","build",".turbo",".cache",
    "__pycache__", ".venv","venv",".ai_repo"
}

CODE_EXT = {".ts",".tsx",".js",".py",".go",".rs",".java"}

API_PATTERNS = [
    r"app\.(get|post|put|delete)\(",
    r"router\.(get|post|put|delete)\(",
    r"@app\.(get|post|put|delete)",
    r"export async function (GET|POST|PUT|DELETE)"
]

IMPORT_PATTERNS = [
    r"import .* from ['\"](.*)['\"]",
    r"require\(['\"](.*)['\"]\)"
]


def ignore(p):
    return any(part in IGNORE_DIRS for part in p.parts)


def get_code_files():
    files = []
    for p in ROOT.rglob("*"):
        if p.is_file() and p.suffix in CODE_EXT and not ignore(p):
            files.append(p)
    return files


def repo_map():
    lines = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in IGNORE_DIRS]

        level = dp.replace(str(ROOT), "").count(os.sep)
        indent = "  " * level

        lines.append(f"{os.path.basename(dp)}/")

        for f in fn:
            lines.append(f"{indent}  {f}")

    return "\n".join(lines)


def detect_frameworks():

    fw = []

    if (ROOT / "next.config.js").exists():
        fw.append("Next.js")

    if (ROOT / "package.json").exists():
        fw.append("Node.js")

    if (ROOT / "requirements.txt").exists():
        fw.append("Python")

    for p in ROOT.rglob("*.py"):
        if not ignore(p):
            if "fastapi" in p.read_text(errors="ignore").lower():
                fw.append("FastAPI")
                break

    return fw


def extract_routes(files):

    routes = []

    for p in files:

        txt = p.read_text(errors="ignore")

        for pat in API_PATTERNS:
            if re.search(pat, txt):
                routes.append(str(p))
                break

    return routes


def deps(files):

    graph = {}

    for p in files:

        txt = p.read_text(errors="ignore")

        imps = []

        for pat in IMPORT_PATTERNS:
            imps += re.findall(pat, txt)

        if imps:
            graph[str(p)] = imps

    out = ""

    for f, d in graph.items():

        out += f"{f}\n"

        for x in d:
            out += f"  -> {x}\n"

    return out


def summaries(files):

    out = []

    for p in files:

        txt = p.read_text(errors="ignore").splitlines()

        snippet = "\n".join(txt[:60])

        out.append(
            f"### {p}\n```\n{snippet}\n```\n"
        )

    return "\n".join(out)


def main():

    AI_DIR.mkdir(exist_ok=True)

    print("Scanning repository...")
    code_files = get_code_files()

    print("Generating repo map...")
    rm = repo_map()

    print("Detecting frameworks...")
    fw = detect_frameworks()

    print("Extracting API routes...")
    routes = extract_routes(code_files)

    print("Building dependency graph...")
    dep_text = deps(code_files)

    print("Generating file summaries...")
    summ = summaries(code_files)

    context = f"""
# AI Repo Context

## Frameworks
{fw}

## Repo Map

{rm}


## API Routes
{chr(10).join(routes)}

## Dependencies

{dep_text}


## File Summaries
{summ}

## AI Task Hints
- run production readiness audits
- detect unused dependencies
- analyze API security
- generate integration tests
- suggest deployment configs
"""

    (AI_DIR / "context.md").write_text(context)

    print("\nAI Repo Brain generated → .ai_repo/context.md")


if __name__ == "__main__":
    main()
