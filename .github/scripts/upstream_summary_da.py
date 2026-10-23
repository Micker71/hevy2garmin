#!/usr/bin/env python3
"""Summarize upstream git log for a Danish GitHub issue (heuristic categories)."""
import json
import subprocess
import sys

def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()

def category(subject):
    s = subject.lower()
    if any(s.startswith(x) for x in ("fix", "bug", "hotfix", "repair")) or any(x in s for x in ("fix ", "regression", "correct ")):
        return "Fejlrettelser"
    if any(s.startswith(x) for x in ("feat", "add", "feature")) or any(x in s for x in ("new ", "support ")):
        return "Nye funktioner"
    return "Vedligeholdelse / øvrige ændringer"

base = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
upstream = sys.argv[2] if len(sys.argv) > 2 else "refs/remotes/upstream/main"
data = git("log", "--format=%h%x09%s", f"{base}..{upstream}").splitlines()
groups = {"Nye funktioner": [], "Fejlrettelser": [], "Vedligeholdelse / øvrige ændringer": []}
for line in data:
    if "\t" not in line:
        continue
    sha, subject = line.split("\t", 1)
    groups[category(subject)].append((sha, subject))

with open("/tmp/upstream-update-issue.md", "w", encoding="utf-8") as f:
    f.write("# Hevy2Garmin – opdateringer fra originalprojektet\n\n")
    f.write(f"**{len(data)} nye commits** i originalprojektet, som endnu ikke findes i din fork.\n\n")
    f.write("## Overblik (automatisk klassificering)\n\n")
    for title, entries in groups.items():
        f.write(f"- **{title}: {len(entries)}**\n")
    f.write("\n> Kategorierne bygger kun på commit-beskeder og er vejledende. Gennemgå ændringerne før en opdatering.\n")
    f.write("\n## Ændringer\n\n")
    for title, entries in groups.items():
        if not entries:
            continue
        f.write(f"### {title}\n\n")
        for sha, subject in entries[:40]:
            safe = subject.replace("\r", " ").replace("\n", " ").replace("]", "\\]")
            f.write(f"- [\x60{sha}\x60](https://github.com/drkostas/hevy2garmin/commit/{sha}) – {safe}\n")
        if len(entries) > 40:
            f.write(f"- ... og {len(entries)-40} flere i denne kategori\n")
        f.write("\n")
    f.write("## Anbefaling\n\n")
    f.write("**Gennemgå og test i en Preview-branch før Production.** Denne kontrol ændrer hverken kode, database eller Vercel.\n\n")
    f.write("- [Se originalprojektet](https://github.com/drkostas/hevy2garmin)\n")
    f.write("- [Åbn din fork](https://github.com/Micker71/hevy2garmin)\n")
    f.write("\n_Genereret automatisk af Upstream Monitor v2.0._\n")
print(json.dumps({k: len(v) for k,v in groups.items()}, ensure_ascii=False))
