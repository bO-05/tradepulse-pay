# LEGACY (TradePulse Pro, Convex hackathon, Sep 2026). Not part of the TradePulse Pay checks.
# This script predates TradePulse Pay and is kept for history only. It is not run by
# package.json, Vitest, CI or any script. The current checks are `npx tsc -b`,
# `npx vitest run --maxWorkers=2` and `npm run build` (see README "Verification").
import os
import re
import json
import datetime
from pathlib import Path

def test_hackathon_md():
    log_path = Path("hackathon.md")
    assert log_path.exists(), "hackathon.md must exist at root"
    content = log_path.read_text(encoding="utf-8")
    lines = [line.rstrip() for line in content.splitlines()]
    
    assert lines[0] == "# Hackathon log", f"First line must be '# Hackathon log', got '{lines[0]}'"
    
    expected_fields = [
        ("Project", "TradePulse Pro"),
        ("Event", "Convex All Gas Hackathon"),
        ("What it does", None),
        ("Live app", None),
        ("Repo", None),
        ("Frontend", "Convex static hosting"),
        ("Convex deployment", None),
        ("Components", [
            "@convex-dev/static-hosting, @firecrawl/firecrawl-convex, @agentmail/convex",
            "@convex-dev/static-hosting",
            "none"
        ]),
        ("Convex features", [
            "schema, tables, indexes, queries, mutations, actions, HTTP actions, scheduled functions, crons, file storage",
            "schema, tables, indexes, queries, mutations, actions, HTTP actions, scheduled functions",
            "none yet"
        ]),
        ("Auth", "none"),
        ("AI models", ["gpt-4o (BYOK), gemini-3.6-flash (pinned; gemini-3.8-flash returns 429), claude-sonnet-5", "gpt-4o-mini, gemini-3.6-flash, claude-sonnet-5", "none"]),
        ("Started", None),
        ("Last updated", None)
    ]
    
    header_lines = []
    idx = 2
    while idx < len(lines) and lines[idx].startswith("- **"):
        header_lines.append(lines[idx])
        idx += 1
        
    assert len(header_lines) == len(expected_fields), f"Expected {len(expected_fields)} header fields, got {len(header_lines)}"
    
    for i, (name, val) in enumerate(expected_fields):
        match = re.match(r"^- \*\*(.*?):\*\* (.*)$", header_lines[i])
        assert match, f"Line {header_lines[i]} does not match header field format"
        field_name, field_val = match.group(1), match.group(2)
        assert field_name == name, f"Field order mismatch: expected {name}, got {field_name}"
        if val is not None:
            if isinstance(val, list):
                assert field_val in val, f"Field '{name}' value '{field_val}' not in allowed values: {val}"
            else:
                assert field_val == val, f"Field '{name}' value mismatch: expected '{val}', got '{field_val}'"
            
    # Check Started timestamp
    started_match = re.match(r"^- \*\*Started:\*\* (.*)$", header_lines[11])
    started_ts = started_match.group(1)
    dt_started = datetime.datetime.fromisoformat(started_ts.replace("Z", "+00:00"))
    assert dt_started.tzinfo is not None, "Started timestamp must include timezone/UTC Z"
    
    # Check Last updated timestamp
    updated_match = re.match(r"^- \*\*Last updated:\*\* (.*)$", header_lines[12])
    updated_ts = updated_match.group(1)
    dt_updated = datetime.datetime.fromisoformat(updated_ts.replace("Z", "+00:00"))
    assert dt_updated.tzinfo is not None, "Last updated timestamp must include timezone/UTC Z"
    assert dt_updated >= dt_started, "Last updated cannot be earlier than Started"
    
    # Check email redaction / secrets
    email_pattern = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
    emails = email_pattern.findall(content)
    assert not emails, f"Found unredacted emails in hackathon.md: {emails}"
    
    # Check section title
    assert "## Log" in content, "Missing '## Log' section"
    
    # Check entry headers
    entries = re.findall(r"^### (\d{4}-\d{2}-\d{2}) - (.*)$", content, re.MULTILINE)
    assert len(entries) >= 1, "At least one log entry must exist"
    for date_str, ref in entries:
        datetime.date.fromisoformat(date_str) # validate date format
        assert ref == "working tree" or len(ref) >= 7, f"Invalid entry ref: {ref}"

    print("PASS: test_hackathon_md")

def test_hackathon_skill():
    skill_dir = Path(".agents/skills/convex-hackathon-skill")
    assert skill_dir.exists(), f"Skill directory {skill_dir} does not exist"
    skill_md = skill_dir / "SKILL.md"
    log_format_md = skill_dir / "references" / "log-format.md"
    
    assert skill_md.exists(), "SKILL.md missing"
    assert log_format_md.exists(), "references/log-format.md missing"
    
    content = skill_md.read_text(encoding="utf-8")
    assert "name: convex-hackathon-skill" in content, "Invalid frontmatter in SKILL.md"
    assert len(content) > 1000, "SKILL.md is too short or empty"
    
    log_format = log_format_md.read_text(encoding="utf-8")
    assert "# Hackathon log format" in log_format, "log-format.md content invalid"
    
    print("PASS: test_hackathon_skill")

def _first_existing(candidates):
    for candidate in candidates:
        if candidate and str(candidate).strip() and Path(candidate).exists():
            return Path(candidate)
    return None

def test_mcp_configuration():
    home = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or ".")
    gemini_mcp = _first_existing([
        os.environ.get("GEMINI_MCP_CONFIG"),
        home / ".gemini" / "config" / "mcp_config.json",
        home / ".config" / "gemini" / "mcp_config.json",
    ])
    if gemini_mcp is None:
        print("SKIP: test_mcp_configuration (no local Gemini MCP config on this machine; set GEMINI_MCP_CONFIG to enforce)")
        return
    cfg = json.loads(gemini_mcp.read_text(encoding="utf-8"))
    assert "convex" in cfg["mcpServers"], "convex server missing in mcp_config.json"
    convex_cfg = cfg["mcpServers"]["convex"]
    assert convex_cfg["command"] == "npx", f"Expected command npx, got {convex_cfg.get('command')}"
    assert convex_cfg["args"] == ["-y", "convex@latest", "mcp", "start"], f"Invalid args: {convex_cfg.get('args')}"

    # Check antigravity mcp schemas (only when the local antigravity install is present)
    gemini_root = gemini_mcp.parent.parent
    schema_dir = _first_existing([
        os.environ.get("ANTIGRAVITY_MCP_DIR"),
        gemini_root / "antigravity" / "mcp" / "convex",
    ])
    if schema_dir is None:
        print("PASS: test_mcp_configuration (antigravity schemas not installed on this machine - sub-check skipped)")
        return
    tools = [f.stem for f in schema_dir.glob("*.json")]
    expected_tools = ["status", "tables", "data", "logs", "run", "runOneoffQuery", "envList", "envGet", "envSet", "envRemove", "functionSpec", "insights"]
    for t in expected_tools:
        assert t in tools, f"Missing MCP tool schema for {t}"

    print("PASS: test_mcp_configuration")

def test_convex_agent_skills():
    home = Path(os.environ.get("USERPROFILE") or os.environ.get("HOME") or ".")
    skills_dir = _first_existing([
        os.environ.get("CONVEX_SKILLS_DIR"),
        home / ".agents" / "skills",
        Path(".agents") / "skills",
    ])
    if skills_dir is None:
        print("SKIP: test_convex_agent_skills (no local convex skills directory found; set CONVEX_SKILLS_DIR to enforce)")
        return
    convex_skills = [d.name for d in skills_dir.iterdir() if d.is_dir() and d.name.startswith("convex")]
    assert len(convex_skills) >= 1, f"Expected at least one convex skill in {skills_dir}, got {len(convex_skills)}"
    print(f"PASS: test_convex_agent_skills ({len(convex_skills)} convex skills in {skills_dir})")

def test_boost_mutations_and_primitives():
    # 1. Bids mutations
    bids_content = Path("convex/bids.ts").read_text(encoding="utf-8")
    assert "export const submitDirectBid = mutation(" in bids_content, "Missing submitDirectBid in convex/bids.ts"
    assert "export const updateBidLeveling = mutation(" in bids_content, "Missing updateBidLeveling in convex/bids.ts"
    assert "export const deleteBid = mutation(" in bids_content, "Missing deleteBid in convex/bids.ts"
    assert "export const unawardContract = mutation(" in bids_content, "Missing unawardContract in convex/bids.ts"

    # 2. RFQ legal addendum generator
    rfq_content = Path("convex/rfq.ts").read_text(encoding="utf-8")
    assert "export const generatePreBidAddendum = action(" in rfq_content, "Missing generatePreBidAddendum in convex/rfq.ts"

    # 3. Files extraction and addendum
    files_content = Path("convex/files.ts").read_text(encoding="utf-8")
    assert "export const extractBidFromQuoteFile = action(" in files_content, "Missing extractBidFromQuoteFile in convex/files.ts"
    assert "export const extractBidFromFile = action(" in files_content, "Missing extractBidFromFile in convex/files.ts"

    # 4. Trade package dynamic inbox provisioning
    trade_pkgs_content = Path("convex/tradePackages.ts").read_text(encoding="utf-8")
    assert "provisionPackageInbox" in trade_pkgs_content, "Missing provisionPackageInbox in tradePackages.ts"

    # 5. Contractor directory CRUD
    contractors_content = Path("convex/contractors.ts").read_text(encoding="utf-8")
    assert "export const createContractor = mutation(" in contractors_content
    assert "export const updateContractor = mutation(" in contractors_content
    assert "export const deleteContractor = mutation(" in contractors_content

    print("PASS: test_boost_mutations_and_primitives")

if __name__ == "__main__":
    test_hackathon_md()
    test_hackathon_skill()
    test_mcp_configuration()
    test_convex_agent_skills()
    test_boost_mutations_and_primitives()
    print("\nALL VERIFICATION TESTS PASSED SUCCESSFULLY!")
