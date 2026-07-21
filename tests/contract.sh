#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 - "$repository_root" <<'PY'
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
action = (root / "action.yml").read_text()
readme = (root / "README.md").read_text()
runtime = (root / "scripts/run.sh").read_text()
extension = (root / "extensions/github-tools.ts").read_text()

def yaml_section(name):
    match = re.search(rf"(?ms)^{name}:\n(.*?)(?=^[a-z][a-z-]*:|\Z)", action)
    if not match:
        raise SystemExit(f"Missing {name} section in action.yml")
    values = {}
    current = None
    for line in match.group(1).splitlines():
        item = re.match(r"^  ([a-z][a-z-]*):$", line)
        if item:
            current = item.group(1)
            values[current] = {"default": "—", "description": "", "required": "false"}
            continue
        field = re.match(r'^    (default|description|required):\s*(.*)$', line)
        if current and field:
            value = field.group(2).strip().strip('"')
            values[current][field.group(1)] = value
    return values

def markdown_table(heading):
    match = re.search(rf"(?ms)^## {re.escape(heading)}\n.*?\n(\| .*?)(?=\n\n|\n## )", readme)
    if not match:
        raise SystemExit(f"Missing README {heading} table")
    rows = {}
    for line in match.group(1).splitlines()[2:]:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 2:
            key = cells[0].strip("`")
            rows[key] = cells
    return rows

inputs = yaml_section("inputs")
outputs = yaml_section("outputs")
readme_inputs = markdown_table("Inputs")
readme_outputs = markdown_table("Outputs")
if set(inputs) != set(readme_inputs):
    raise SystemExit(f"README/action input mismatch: {sorted(set(inputs) ^ set(readme_inputs))}")
if set(outputs) != set(readme_outputs):
    raise SystemExit(f"README/action output mismatch: {sorted(set(outputs) ^ set(readme_outputs))}")
for name, metadata in inputs.items():
    documented_required = readme_inputs[name][1]
    expected_required = "Yes" if metadata["required"] == "true" else "No"
    if documented_required != expected_required:
        raise SystemExit(f"Required mismatch for {name}: README={documented_required}, action.yml={expected_required}")
    documented = readme_inputs[name][2]
    expected = metadata["default"]
    if expected == "—" and name in {"provider", "model", "thinking"}:
        expected = "Pi default"
    if documented.strip("`") != expected:
        raise SystemExit(f"Default mismatch for {name}: README={documented}, action.yml={expected}")
for name in ("thinking", "github-tools"):
    action_values = set(re.findall(r"\b(?:off|minimal|low|medium|high|xhigh|max|none|read|write)\b", inputs[name]["description"]))
    readme_values = set(re.findall(r"`(off|minimal|low|medium|high|xhigh|max|none|read|write)`", readme_inputs[name][3]))
    if action_values != readme_values:
        raise SystemExit(f"Enum mismatch for {name}: README={sorted(readme_values)}, action.yml={sorted(action_values)}")
if "must begin with `./`" not in readme:
    raise SystemExit("README must state that workspace package paths begin with ./")

runtime_version_match = re.search(r'^version="\$\{PI_AGENT_INPUT_VERSION:-(.*?)\}"$', runtime, re.M)
if not runtime_version_match:
    raise SystemExit("Unable to find the Pi runtime fallback version in scripts/run.sh")
action_version = inputs["pi-version"]["default"]
runtime_version = runtime_version_match.group(1)
if action_version != runtime_version:
    raise SystemExit(f"Pi version mismatch: action.yml={action_version}, scripts/run.sh={runtime_version}")

registered = re.findall(r'pi\.registerTool\(\{\s*name:\s*"([^"]+)"', extension)
mode_boundary = extension.find('if (mode !== "write") return;')
if mode_boundary < 0:
    raise SystemExit("Unable to identify the GitHub write-tool boundary")
read_registered = re.findall(r'pi\.registerTool\(\{\s*name:\s*"([^"]+)"', extension[:mode_boundary])
write_registered = registered[len(read_registered):]
read_selection = re.search(r"github_tool_names='([^']+)'", runtime)
write_selection = re.search(r"github_tool_names\+=',([^']+)'", runtime)
if not read_selection or not write_selection:
    raise SystemExit("Unable to find GitHub tool selections in scripts/run.sh")
runtime_read = read_selection.group(1).split(",")
runtime_write = write_selection.group(1).split(",")
if runtime_read != read_registered:
    raise SystemExit(f"GitHub read-tool mismatch: scripts/run.sh={runtime_read}, extension={read_registered}")
if runtime_write != write_registered:
    raise SystemExit(f"GitHub write-tool mismatch: scripts/run.sh={runtime_write}, extension={write_registered}")
print("README/action/runtime contract tests passed.")
PY
