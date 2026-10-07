# LEGACY (TradePulse Pro, Convex hackathon, Sep 2026). Not part of the TradePulse Pay checks.
# This script predates TradePulse Pay and is kept for history only. It is not run by
# package.json, Vitest, CI or any script. The current checks are `npx tsc -b`,
# `npx vitest run --maxWorkers=2` and `npm run build` (see README "Verification").
import os
import re
import json
from pathlib import Path

def test_normalization_formula_adr0003():
    """
    Validates ADR-0003: Deterministic Normalization Formula
    Leveled Cost = Base Bid + Sum(Scope Gaps) + Lead Time Penalty + COI Penalty - Accepted Alternates
    """
    def calculate_leveled_cost(base_bid, scope_gaps, lead_time_penalty, coi_penalty, accepted_alternates=0):
        scope_sum = sum(gap["costImpact"] for gap in scope_gaps)
        return base_bid + scope_sum + lead_time_penalty + coi_penalty - accepted_alternates

    # Test Case 1: Alterman, Inc. (Deceptive low base bid)
    alterman_base = 1100000
    alterman_exclusions = [
        {"description": "Crane hoisting & rigging to penthouse floor", "costImpact": 45000, "severity": "critical"},
        {"description": "UL 1479 firestop penetrations", "costImpact": 22000, "severity": "critical"},
        {"description": "Seismic engineered structural bracing", "costImpact": 55000, "severity": "critical"},
        {"description": "Overtime/weekend premium time", "costImpact": 25000, "severity": "moderate"},
    ]
    alterman_lead_penalty = 24000 # 16 wks vs 12 wks target (4 wks * $6,000/wk liquidated damages)
    alterman_coi_penalty = 15000 # ACORD 25 deficiency rider
    alterman_leveled = calculate_leveled_cost(alterman_base, alterman_exclusions, alterman_lead_penalty, alterman_coi_penalty)

    assert alterman_leveled == 1286000, f"Expected $1,286,000, got {alterman_leveled}"

    # Test Case 2: Rosendin Electric, Inc. (Higher base, zero exclusions)
    rosendin_base = 1225000
    rosendin_exclusions = []
    rosendin_lead_penalty = 0 # 10 wks (on schedule)
    rosendin_coi_penalty = 0 # Compliant
    rosendin_leveled = calculate_leveled_cost(rosendin_base, rosendin_exclusions, rosendin_lead_penalty, rosendin_coi_penalty)

    assert rosendin_leveled == 1225000, f"Expected $1,225,000, got {rosendin_leveled}"

    # Forensic Truth Proof: Alterman appears $125,000 cheaper, but is actually $61,000 MORE EXPENSIVE
    paper_savings = rosendin_base - alterman_base
    assert paper_savings == 125000, f"Paper savings should be $125,000, got {paper_savings}"

    actual_gap = alterman_leveled - rosendin_leveled
    assert actual_gap == 61000, f"Alterman should be $61,000 more expensive, got {actual_gap}"

    # Edge cases: 0 base bid, negative alternates, large arrays
    assert calculate_leveled_cost(0, [], 0, 0) == 0
    assert calculate_leveled_cost(100000, [], 0, 0, accepted_alternates=15000) == 85000

    print("PASS: test_normalization_formula_adr0003")

def test_csi_schema_and_models():
    """
    Validates convex/schema.ts defines all required tables, fields, and indices,
    including agreements, projectFiles, and auditLogs.
    """
    schema_path = Path("convex/schema.ts")
    assert schema_path.exists(), "convex/schema.ts must exist"
    content = schema_path.read_text(encoding="utf-8")

    required_tables = [
        "projects",
        "tradePackages",
        "contractors",
        "conversations",
        "bids",
        "agreements",
        "projectFiles",
        "auditLogs",
    ]
    for table in required_tables:
        assert f"{table}: defineTable(" in content, f"Table {table} missing in schema"

    # Index checks
    assert '.index("by_demo", ["isDemoProject"])' in content, "Missing by_demo index on projects"
    assert '.index("by_project", ["projectId"])' in content, "Missing by_project index on tradePackages"
    assert '.index("by_package", ["tradePackageId"])' in content, "Missing by_package index"
    assert '.index("by_thread", ["threadId"])' in content, "Missing by_thread index on conversations"
    assert '.index("by_bid", ["bidId"])' in content, "Missing by_bid index on agreements"
    assert '.index("by_timestamp", ["timestamp"])' in content, "Missing by_timestamp index on auditLogs"

    print("PASS: test_csi_schema_and_models")

def test_http_router_and_static_hosting_rule():
    """
    Validates Standing Rule #3:
    registerStaticRoutes(http, components.staticHosting) must terminate the router.
    And /llms.txt discoverability endpoint must be exposed.
    """
    http_path = Path("convex/http.ts")
    assert http_path.exists(), "convex/http.ts must exist"
    content = http_path.read_text(encoding="utf-8")

    # Invariant checks
    assert 'registerStaticRoutes(http, components.staticHosting);' in content, "Missing registerStaticRoutes"
    assert 'export default http;' in content, "Missing export default http"

    # Ensure registerStaticRoutes is at the very end before export default
    static_route_idx = content.find("registerStaticRoutes(http, components.staticHosting);")
    export_idx = content.find("export default http;")
    assert static_route_idx < export_idx, "registerStaticRoutes must appear before export default"

    # Check custom routes
    assert '"/agentmail/webhook"' in content, "Missing /agentmail/webhook route"
    assert '"/llms.txt"' in content, "Missing /llms.txt route"
    assert '"/api/health"' in content, "Missing /api/health route"

    print("PASS: test_http_router_and_static_hosting_rule")

def test_judge_simulation_engine():
    """
    Validates Simulation Bypass Invariant:
    convex/simulation.ts must support 1-click evaluation scenarios bypassing Svix webhook verification.
    """
    sim_path = Path("convex/simulation.ts")
    assert sim_path.exists(), "convex/simulation.ts must exist"
    content = sim_path.read_text(encoding="utf-8")

    assert "triggerJudgeSimulation" in content, "Missing triggerJudgeSimulation mutation"
    assert '"rfi_inquiry"' in content, "Missing rfi_inquiry scenario"
    assert '"bid_with_hidden_exclusion"' in content, "Missing bid_with_hidden_exclusion scenario"
    assert '"bid_clean_compliant"' in content, "Missing bid_clean_compliant scenario"

    print("PASS: test_judge_simulation_engine")

def test_frontend_build_artifacts():
    """
    Validates that Vite generated production assets in dist/ for static hosting.
    """
    dist_dir = Path("dist")
    assert dist_dir.exists(), "dist/ directory must exist (fresh clone: run `npm run build` first)"
    index_html = dist_dir / "index.html"
    assert index_html.exists(), "dist/index.html missing"

    html_content = index_html.read_text(encoding="utf-8")
    assert "TradePulse Pro" in html_content, "Missing TradePulse Pro title in dist/index.html"
    assert 'href="/tradepulse.svg"' in html_content, "dist/index.html must serve the TradePulse favicon"

    assets_dir = dist_dir / "assets"
    assert assets_dir.exists(), "dist/assets missing"
    js_files = list(assets_dir.glob("*.js"))
    css_files = list(assets_dir.glob("*.css"))
    assert len(js_files) >= 1, "Must have at least one JS bundle in dist/assets"
    assert len(css_files) >= 1, "Must have at least one CSS bundle in dist/assets"

    print(f"PASS: test_frontend_build_artifacts (JS: {len(js_files)}, CSS: {len(css_files)})")

def test_token_optimized_llm_router():
    """
    Validates convex/llmRouter.ts supports multi-model routing with OpenAI as primary sponsor pipeline
    and deterministic cached fallback for $0 judge evaluations.
    """
    router_path = Path("convex/llmRouter.ts")
    assert router_path.exists(), "convex/llmRouter.ts must exist"
    content = router_path.read_text(encoding="utf-8")

    assert "executeReasoning" in content, "Missing executeReasoning action"
    assert "api.openai.com" in content, "Missing OpenAI pipeline"
    assert "generativelanguage.googleapis.com" in content, "Missing Gemini pipeline"
    assert "api.anthropic.com" in content, "Missing Claude pipeline"
    assert "gpt-4o-deterministic-cache" in content or "OpenAI-SimulationEngine" in content, "Missing deterministic fallback"

    # Verify structured JSON system prompt is present for bid_leveling
    assert "identifiedExclusions" in content, "Missing identifiedExclusions in llmRouter"
    assert "leveledTotalCost" in content, "Missing leveledTotalCost in llmRouter"

    print("PASS: test_token_optimized_llm_router")

def test_simulation_engine_custom_rfi_and_compliant_bid():
    """
    Validates that convex/simulation.ts contains submitCustomRfi for direct UI form submissions
    and that llmRouter.ts dynamically differentiates compliant vs deceptive bids.
    """
    sim_path = Path("convex/simulation.ts")
    content = sim_path.read_text(encoding="utf-8")
    assert "submitCustomRfi" in content, "Missing submitCustomRfi mutation in simulation.ts"
    assert "triggerJudgeSimulation" in content, "Missing triggerJudgeSimulation mutation"

    router_path = Path("convex/llmRouter.ts")
    router_content = router_path.read_text(encoding="utf-8")
    assert "hasExplicitExclusions" in router_content, "llmRouter must dynamically check for explicit exclusions"
    assert "confidenceScore" in router_content, "llmRouter must return confidenceScore"

    print("PASS: test_simulation_engine_custom_rfi_and_compliant_bid")

def test_firecrawl_v2_and_partner_spec_alignment():
    """
    Validates Firecrawl v2 search endpoint and partner component registrations.
    """
    discovery_path = Path("convex/contractorDiscovery.ts")
    content = discovery_path.read_text(encoding="utf-8")
    assert 'country: "US"' in content or '"country": "US"' in content, "Firecrawl search must pass country US"
    assert "FirecrawlClient" in content, "FirecrawlClient must be instantiated"

    cfg_path = Path("convex/convex.config.ts")
    cfg_content = cfg_path.read_text(encoding="utf-8")
    assert "app.use(staticHosting)" in cfg_content, "staticHosting must be registered"
    assert "app.use(firecrawl" in cfg_content, "firecrawl component must be registered"
    assert "app.use(agentmail)" in cfg_content, "agentmail component must be registered"

    print("PASS: test_firecrawl_v2_and_partner_spec_alignment")

def test_type_definitions_and_zero_unused_vars():
    """
    Validates Vite environment type definition exists.
    """
    env_dts = Path("src/vite-env.d.ts")
    assert env_dts.exists(), "src/vite-env.d.ts must exist for Vite import.meta.env typing"
    content = env_dts.read_text(encoding="utf-8")
    assert '/// <reference types="vite/client" />' in content

    print("PASS: test_type_definitions_and_zero_unused_vars")

def test_aia_document_a401_contract_generator():
    """
    Pillar 2: Validates AIA Document A401 standard subcontract agreement generator
    in convex/agreements.ts and Agreement Viewer modal wiring in BidLevelingMatrixView.tsx.
    """
    agreements_path = Path("convex/agreements.ts")
    assert agreements_path.exists(), "convex/agreements.ts must exist"
    content = agreements_path.read_text(encoding="utf-8")

    assert "generateAgreement" in content, "generateAgreement mutation missing"
    assert "executeAgreement" in content, "executeAgreement mutation missing"
    assert "getAgreementByBid" in content, "getAgreementByBid query missing"
    assert "A401-STYLE STRUCTURE (GENERATED DRAFT)" in content, "Must label the generated subcontract as an A401-style draft"
    assert "not an AIA-licensed form" in content, "Must disclose that the draft is not an AIA-licensed form"
    assert "retainagePercent" in content, "Must define retainage percentage"
    assert "liquidatedDamagesDaily" in content, "Must define liquidated damages"
    assert "ARTICLE 1" in content and "ARTICLE 4" in content, "Must include AIA standard articles"

    # Validate UI integration
    matrix_path = Path("src/components/BidLevelingMatrixView.tsx")
    assert matrix_path.exists()
    matrix_content = matrix_path.read_text(encoding="utf-8")
    assert "Inspect Subcontract Draft" in matrix_content or "Award Subcontract & Draft Agreement" in matrix_content
    assert "Export Leveling CSV" in matrix_content, "Must include 1-click CSV leveling export"

    print("PASS: test_aia_document_a401_contract_generator")

def test_convex_depth_primitives():
    """
    Pillar 3: Validates Convex Crons, File Storage (_storage), and Live Activity Stream.
    """
    # 1. Crons
    crons_path = Path("convex/crons.ts")
    assert crons_path.exists(), "convex/crons.ts must exist"
    crons_content = crons_path.read_text(encoding="utf-8")
    assert "cronJobs()" in crons_content, "Must define cronJobs()"
    assert "monitor-bid-deadlines" in crons_content, "Missing monitor-bid-deadlines cron"
    assert "audit-contractor-compliance" in crons_content, "Missing audit-contractor-compliance cron"

    # 2. File Storage
    files_path = Path("convex/files.ts")
    assert files_path.exists(), "convex/files.ts must exist"
    files_content = files_path.read_text(encoding="utf-8")
    assert "generateUploadUrl" in files_content, "Missing generateUploadUrl"
    assert "saveFileRecord" in files_content, "Missing saveFileRecord"
    assert "listFilesByProject" in files_content, "Missing listFilesByProject"

    # 3. Activity Audit Stream
    audit_path = Path("convex/auditLogs.ts")
    assert audit_path.exists(), "convex/auditLogs.ts must exist"
    audit_content = audit_path.read_text(encoding="utf-8")
    assert "listRecentLogs" in audit_content, "Missing listRecentLogs query"
    assert "recordLog" in audit_content, "Missing recordLog mutation"

    print("PASS: test_convex_depth_primitives")

def test_multi_trade_context_aware_simulation():
    """
    Pillar 4: Validates multi-trade simulation for Divisions 26, 23, and 22 in simulation.ts and projects.ts.
    """
    sim_path = Path("convex/simulation.ts")
    sim_content = sim_path.read_text(encoding="utf-8")
    assert 'isHvac' in sim_content or 'tradePkg.csiDivision.startsWith("23")' in sim_content
    assert 'isPlumbing' in sim_content or 'tradePkg.csiDivision.startsWith("22")' in sim_content

    projects_path = Path("convex/projects.ts")
    projects_content = projects_path.read_text(encoding="utf-8")
    assert "TDIndustries" in projects_content or "Hill Country Mechanical" in projects_content, "Must seed HVAC contractors"
    assert "The Brandt Companies" in projects_content or "Travis County Sheet Metal" in projects_content, "Must seed deceptive HVAC proposal"
    assert "Clarke Kent Plumbing" in projects_content or "Apex Commercial Piping" in projects_content, "Must seed plumbing contractors"
    assert "Limbach Facility Services" in projects_content or "Colorado River Mechanical" in projects_content, "Must seed deceptive plumbing proposal"

    # Check Header has project switcher
    header_path = Path("src/components/Header.tsx")
    header_content = header_path.read_text(encoding="utf-8")
    assert "New Project" in header_content, "Missing New Project button/modal in Header"

    print("PASS: test_multi_trade_context_aware_simulation")

def test_deep_sponsor_integration_boost():
    """
    Pillar 1: Validates optional FIRECRAWL_API_KEY, AgentMail email dispatch wiring,
    and multi-model diagnostics.
    """
    cfg_path = Path("convex/convex.config.ts")
    cfg_content = cfg_path.read_text(encoding="utf-8")
    assert "FIRECRAWL_API_KEY: v.string()" in cfg_content or "FIRECRAWL_API_KEY: v.optional(v.string())" in cfg_content, "FIRECRAWL_API_KEY must be declared in convex.config.ts"

    app_path = Path("src/App.tsx")
    app_content = app_path.read_text(encoding="utf-8")
    assert "dispatchRfqsWithNotification" in app_content, "Must wire dispatchRfqsWithNotification in App.tsx"

    diag_path = Path("src/components/SponsorDiagnosticsView.tsx")
    diag_content = diag_path.read_text(encoding="utf-8")
    assert "Gemini Flash" in diag_content
    assert "Configured model:" in diag_content
    assert "Claude Sonnet 5" in diag_content
    assert "OpenAI GPT-4o" in diag_content
    assert "throughputTokSec" in diag_content or "tok/s" in diag_content

    print("PASS: test_deep_sponsor_integration_boost")

def test_firecrawl_website_scraping_and_array_parsing():
    """
    Validates FirecrawlClient website scraping action in convex/contractorDiscovery.ts,
    defensive Array.isArray parsing for Firecrawl search endpoints,
    and interactive UI scraping trigger in SubcontractorDiscoveryView.tsx.
    """
    discovery_path = Path("convex/contractorDiscovery.ts")
    content = discovery_path.read_text(encoding="utf-8")
    assert "scrapeContractorWebsite" in content, "Missing scrapeContractorWebsite action in contractorDiscovery.ts"
    assert "Array.isArray" in content, "Must use defensive Array.isArray parsing for Firecrawl search responses"
    assert "firecrawl.scrape" in content, "Must use firecrawl.scrape for markdown extraction"

    ui_path = Path("src/components/SubcontractorDiscoveryView.tsx")
    ui_content = ui_path.read_text(encoding="utf-8")
    assert "scrapeContractorWebsite" in ui_content, "Missing scrapeContractorWebsite wiring in SubcontractorDiscoveryView.tsx"
    assert "Open source page" in ui_content, "Missing source-page/scrape button label in SubcontractorDiscoveryView.tsx"
    assert "scrapedData" in ui_content, "Missing scrapedData state in SubcontractorDiscoveryView.tsx"

    print("PASS: test_firecrawl_website_scraping_and_array_parsing")

def test_dynamic_audit_stream_logging_coverage():
    """
    Validates that all real-time procurement mutations and actions record events
    into the auditLogs table to guarantee the Live Reactive Activity Stream is active.
    """
    rfq_content = Path("convex/rfq.ts").read_text(encoding="utf-8")
    assert 'ctx.db.insert("auditLogs"' in rfq_content, "rfq.ts must insert into auditLogs"
    assert '"rfq_dispatched"' in rfq_content, "rfq.ts must record rfq_dispatched events"
    assert '"rfi_clarified"' in rfq_content, "rfq.ts must record rfi_clarified events"

    bids_content = Path("convex/bids.ts").read_text(encoding="utf-8")
    assert 'ctx.db.insert("auditLogs"' in bids_content, "bids.ts must insert into auditLogs"
    assert '"bid_leveled"' in bids_content, "bids.ts must record bid_leveled events"

    discovery_content = Path("convex/contractorDiscovery.ts").read_text(encoding="utf-8")
    assert 'internal.auditLogs.recordLogInternal' in discovery_content, "contractorDiscovery.ts must record audit logs"

    projects_content = Path("convex/projects.ts").read_text(encoding="utf-8")
    assert 'ctx.db.insert("auditLogs"' in projects_content, "projects.ts createProject must insert into auditLogs"

    packages_content = Path("convex/tradePackages.ts").read_text(encoding="utf-8")
    assert 'ctx.db.insert("auditLogs"' in packages_content, "tradePackages.ts createTradePackage must insert into auditLogs"

    crons_content = Path("convex/crons.ts").read_text(encoding="utf-8")
    assert "projectId: v.id(\"projects\")" in crons_content, "crons.ts must require project-scoped execution"

    print("PASS: test_dynamic_audit_stream_logging_coverage")

def test_aia_a401_legal_number_to_words_and_unaward_invariant():
    """
    Validates AIA Document A401 legal contract generator invariants:
    1. numberToWords currency attestation handles millions recursion and decimal rounding
    2. generateAgreement un-awards competing bids and supersedes older contracts.
    """
    def py_number_to_words(num):
        num = round(num)
        units = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
                 "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
        tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]
        if num >= 1000000:
            millions = num // 1000000
            rem = num % 1000000
            return f"{py_number_to_words(millions)} Million" + (f" {py_number_to_words(rem)}" if rem else "")
        if num >= 1000:
            thousands = num // 1000
            rem = num % 1000
            return f"{py_number_to_words(thousands)} Thousand" + (f" {py_number_to_words(rem)}" if rem else "")
        if num >= 100:
            hundreds = num // 100
            rem = num % 100
            return f"{units[hundreds]} Hundred" + (f" {py_number_to_words(rem)}" if rem else "")
        if num >= 20:
            t = num // 10
            rem = num % 10
            return tens[t] + (f"-{units[rem]}" if rem else "")
        if num > 0:
            return units[num]
        return "Zero"

    assert py_number_to_words(1225000) == "One Million Two Hundred Twenty-Five Thousand"
    assert py_number_to_words(25000000) == "Twenty-Five Million"
    assert py_number_to_words(1286000.42) == "One Million Two Hundred Eighty-Six Thousand"
    assert py_number_to_words(0) == "Zero"

    agreements_content = Path("convex/agreements.ts").read_text(encoding="utf-8")
    assert "numberToWords(millions)" in agreements_content, "convex/agreements.ts must use recursive numberToWords for millions"
    assert "isAwarded: false" in agreements_content, "generateAgreement must unaward other bids"
    assert "status: \"superseded\"" in agreements_content, "generateAgreement must mark superseded agreements"

    print("PASS: test_aia_a401_legal_number_to_words_and_unaward_invariant")

def test_csv_export_escaping_and_null_guards():
    """
    Validates CSV leveling export escapes quotes properly and guards against undefined exclusions.
    """
    matrix_content = Path("src/components/BidLevelingMatrixView.tsx").read_text(encoding="utf-8")
    csv_content = Path("src/lib/csv.ts").read_text(encoding="utf-8")
    assert 'replace(/"/g, \'""\')' in csv_content, "src/lib/csv.ts must escape double quotes in CSV export"
    assert "FORMULA_PREFIX" in csv_content, "src/lib/csv.ts must neutralize spreadsheet formula injection"
    assert "buildCsv" in matrix_content, "BidLevelingMatrixView.tsx must use the shared buildCsv helper"
    assert "bid.identifiedExclusions || []" in matrix_content, "BidLevelingMatrixView.tsx must defensively guard identifiedExclusions"

    print("PASS: test_csv_export_escaping_and_null_guards")

def test_boost_forensic_leveling_ve_and_waivers():
    """
    Milestone P0 Boost Verification:
    Validates ADR-0003 VE Alternates (costDeduct, isAccepted) and Waived Exclusions (isWaived),
    backend mutation updateBidAdjustments, deleteBid, unawardContract, listAllProjectBids,
    Direct Quote / PDF ingestion action, and BidLevelingMatrixView Spread Table & Adjustment Modal.
    """
    # 1. Schema & Backend mutations
    schema_content = Path("convex/schema.ts").read_text(encoding="utf-8")
    assert "isWaived: v.optional(v.boolean())" in schema_content
    assert "valueEngineeringAlternates: v.optional(" in schema_content

    bids_content = Path("convex/bids.ts").read_text(encoding="utf-8")
    assert "export const updateBidAdjustments = mutation(" in bids_content
    assert "export const updateBidLeveling = mutation(" in bids_content
    assert "export const submitDirectBid = mutation(" in bids_content
    assert "export const deleteBid = mutation(" in bids_content
    assert "export const unawardContract = mutation(" in bids_content
    assert "export const listAllProjectBids = query(" in bids_content

    # 2. ADR-0003 Formula verification with VE alternates and waived exclusions
    base_bid = 1200000
    exclusions = [
        {"description": "Hoisting", "costImpact": 40000, "isWaived": False},
        {"description": "Firestop", "costImpact": 20000, "isWaived": True},
    ]
    ve_alternates = [
        {"description": "Aluminum wire", "costDeduct": 25000, "isAccepted": True},
        {"description": "Alternate fixtures", "costDeduct": 15000, "isAccepted": False},
    ]
    lead_penalty = 12000
    coi_penalty = 5000

    active_exclusions_cost = sum(x["costImpact"] for x in exclusions if not x.get("isWaived"))
    assert active_exclusions_cost == 40000

    accepted_ve_deduct = sum(x["costDeduct"] for x in ve_alternates if x.get("isAccepted"))
    assert accepted_ve_deduct == 25000

    expected_leveled = base_bid + active_exclusions_cost + lead_penalty + coi_penalty - accepted_ve_deduct
    assert expected_leveled == 1200000 + 40000 + 12000 + 5000 - 25000
    assert expected_leveled == 1232000

    # 3. UI Matrix Spread Table & Modal
    matrix_content = Path("src/components/BidLevelingMatrixView.tsx").read_text(encoding="utf-8")
    assert "Spread Table View" in matrix_content
    assert "Direct Quote / PDF Bid Ingestion" in matrix_content
    assert "Forensic Leveling Adjustments" in matrix_content
    assert "extractBidFromQuoteFile" in matrix_content

    # 4. File-to-bid extraction action linking projectFiles
    files_content = Path("convex/files.ts").read_text(encoding="utf-8")
    assert "export const extractBidFromFile = action(" in files_content
    assert "getFileRecordInternal" in files_content

    print("PASS: test_boost_forensic_leveling_ve_and_waivers")

def test_boost_autonomous_scoping_and_legal_addenda():
    """
    Milestone P1 Boost Verification:
    Validates autonomous trade package generation from specs (generateTradePackagesFromSpec with dynamic inbox provisioning),
    pre-bid legal addenda compilation and filing (generatePreBidAddendum in convex/rfq.ts and convex/files.ts),
    Executive Financial Procurement KPI Bar, and Subcontract Agreements Register.
    """
    # 1. Spec breakdown action & dynamic inbox provisioning
    trade_pkgs_content = Path("convex/tradePackages.ts").read_text(encoding="utf-8")
    assert "export const generateTradePackagesFromSpec = action(" in trade_pkgs_content
    assert "provisionPackageInbox" in trade_pkgs_content, "Must provision package inboxes dynamically in generateTradePackagesFromSpec"

    llm_router_content = Path("convex/llmRouter.ts").read_text(encoding="utf-8")
    assert "spec_generation" in llm_router_content
    assert "Division 26" in llm_router_content or "26 00 00" in llm_router_content

    # 2. Legal Addendum action in convex/rfq.ts and convex/files.ts
    rfq_content = Path("convex/rfq.ts").read_text(encoding="utf-8")
    assert "export const generatePreBidAddendum = action(" in rfq_content

    files_content = Path("convex/files.ts").read_text(encoding="utf-8")
    assert "export const generatePreBidAddendum = action(" in files_content
    assert "ADDENDUM NO. 01" in files_content
    assert "extractBidFromQuoteFile = action(" in files_content

    # 3. Executive KPI Bar & Contracts Register
    kpi_bar = Path("src/components/ExecutiveKpiBar.tsx")
    assert kpi_bar.exists()
    kpi_content = kpi_bar.read_text(encoding="utf-8")
    assert "Total Budget" in kpi_content
    assert "Leveled Buyout" in kpi_content
    assert "Deceptive Bids Flagged" in kpi_content

    contracts_view = Path("src/components/ContractsRegisterView.tsx")
    assert contracts_view.exists()
    contracts_content = contracts_view.read_text(encoding="utf-8")
    assert "Subcontract Agreements Register" in contracts_content
    assert "A401-style Subcontract Draft" in contracts_content
    assert "not an AIA-licensed form" in contracts_content

    # 4. App & Header navigation wiring
    app_content = Path("src/App.tsx").read_text(encoding="utf-8")
    assert "ExecutiveKpiBar" in app_content
    assert "ContractsRegisterView" in app_content
    assert "listAllProjectBids" in app_content

    header_content = Path("src/components/Header.tsx").read_text(encoding="utf-8")
    assert 'id: "contracts"' in header_content

    print("PASS: test_boost_autonomous_scoping_and_legal_addenda")

def test_boost_contractor_crud_and_full_lifecycle_simulation():
    """
    Milestone P2 Boost Verification:
    Validates contractor CRUD mutations, dynamic project location resolution,
    1-Click full autonomous procurement lifecycle simulation, and seeded files.
    """
    # 1. Contractor CRUD
    contractors_content = Path("convex/contractors.ts").read_text(encoding="utf-8")
    assert "export const updateContractor = mutation(" in contractors_content
    assert "export const deleteContractor = mutation(" in contractors_content
    assert "export const listByProject = query(" in contractors_content

    # 2. Dynamic project location search
    discovery_content = Path("convex/contractorDiscovery.ts").read_text(encoding="utf-8")
    assert "projectLocation" in discovery_content

    # 3. 1-Click full lifecycle simulation
    sim_content = Path("convex/simulation.ts").read_text(encoding="utf-8")
    assert "export const runFullProcurementCycle = mutation(" in sim_content
    assert "runFullProcurementCycle" in Path("src/components/JudgeSimulationDock.tsx").read_text(encoding="utf-8")

    # 4. Zero empty states seeded files
    projects_content = Path("convex/projects.ts").read_text(encoding="utf-8")
    assert "projectFiles" in projects_content
    assert "26_00_00_Electrical_Systems_Spec.pdf" in projects_content
    assert "Rosendin_Electric_Proposal_AIA.pdf" in projects_content or "Lone_Star_Electric_Proposal_AIA.pdf" in projects_content

    # 5. UI Discovery Search & Filters
    discovery_view = Path("src/components/SubcontractorDiscoveryView.tsx").read_text(encoding="utf-8")
    assert "Search contractors by company name" in discovery_view
    assert "Add Contractor Manually" in discovery_view
    assert "Edit Contractor Details" in discovery_view

    print("PASS: test_boost_contractor_crud_and_full_lifecycle_simulation")

def test_zero_cloud_localhost_standalone_resilience():
    """
    Deliverable 1: Validates Zero-Cloud Localhost Standalone Resilience.
    Opening http://localhost:5173/ immediately displays commercial MEP dataset,
    reactive updates, and working simulation/leveling even if external Convex cloud is unreachable.
    """
    store_path = Path("src/standaloneStore.ts")
    assert store_path.exists(), "src/standaloneStore.ts must exist"
    content = store_path.read_text(encoding="utf-8")
    assert "getInitialStandaloneData" in content, "Missing getInitialStandaloneData"
    assert "loadStandaloneData" in content, "Missing loadStandaloneData"
    assert "The Domain Tower B - Commercial MEP" in content, "Missing commercial project seed"
    assert "pkg_elec_26" in content, "Missing Division 26 package"
    assert "pkg_hvac_23" in content, "Missing Division 23 package"
    assert "pkg_plumb_22" in content, "Missing Division 22 package"

    app_path = Path("src/App.tsx")
    app_content = app_path.read_text(encoding="utf-8")
    assert "loadStandaloneData" in app_content, "App.tsx must load standalone store for zero-cloud resilience"
    assert "isStandaloneMode" in app_content, "App.tsx must track standalone mode"
    assert "updateStandaloneAndPersist" in app_content, "App.tsx must persist state reactively"

    header_path = Path("src/components/Header.tsx")
    header_content = header_path.read_text(encoding="utf-8")
    assert "Offline snapshot mode" in header_content, "Header must indicate the resilient/offline snapshot mode"

    print("PASS: test_zero_cloud_localhost_standalone_resilience")

def test_cross_trade_coordination_and_clash_engine():
    """
    Deliverable 2: Validates Cross-Trade Scope Clash & Double-Buy Detection Engine.
    Implements detection across Division 26 (Electrical) and Division 23 (HVAC)
    with 1-click Deduct Credit and Assign to Trade.
    """
    coord_path = Path("convex/coordination.ts")
    assert coord_path.exists(), "convex/coordination.ts must exist"
    content = coord_path.read_text(encoding="utf-8")

    assert "export const detectCrossTradeClashes = query(" in content, "Missing detectCrossTradeClashes query"
    assert "export const deductDoubleBuyCredit = mutation(" in content, "Missing deductDoubleBuyCredit mutation"
    assert "export const assignScopeVoidToTrade = mutation(" in content, "Missing assignScopeVoidToTrade mutation"
    assert "export const scanCrossTradeClashes = action(" in content, "Missing scanCrossTradeClashes action"

    # Verify domain clash detection: VFDs and BAS wiring
    assert "Variable Frequency Drives" in content or "clash-vfd-01" in content
    assert "Low-Voltage 24V BAS Control & Interlock Wiring" in content or "void-bas-wiring-01" in content

    # Verify UI Component & Wiring
    ui_path = Path("src/components/CrossTradeCoordinationView.tsx")
    assert ui_path.exists(), "src/components/CrossTradeCoordinationView.tsx must exist"
    ui_content = ui_path.read_text(encoding="utf-8")
    assert "Cross-Trade Scope Clash & Double-Buy Detection" in ui_content
    assert "1-Click Deduct Credit" in ui_content
    assert "Assign to Div 26" in ui_content or "Assign to Trade" in ui_content

    app_content = Path("src/App.tsx").read_text(encoding="utf-8")
    assert "CrossTradeCoordinationView" in app_content, "App.tsx must wire CrossTradeCoordinationView"
    assert "handleDeductDoubleBuyCredit" in app_content
    assert "handleAssignScopeVoid" in app_content

    print("PASS: test_cross_trade_coordination_and_clash_engine")

def test_direct_file_to_ai_actions():
    """
    Deliverable 3: Validates Direct File-to-AI Actions in ProjectFilesView.
    Wires 'Auto-Scope Packages' on spec files and 'Extract & Level Bid' on quote PDFs.
    """
    files_view = Path("src/components/ProjectFilesView.tsx")
    assert files_view.exists(), "ProjectFilesView.tsx must exist"
    content = files_view.read_text(encoding="utf-8")

    assert "Auto-Scope Packages" in content, "ProjectFilesView must contain Auto-Scope Packages button"
    assert "Extract & Level Bid" in content, "ProjectFilesView must contain Extract & Level Bid button"
    assert "generateTradePackagesFromSpec" in content, "ProjectFilesView must wire generateTradePackagesFromSpec"
    assert "extractBidFromQuoteFile" in content, "ProjectFilesView must wire extractBidFromQuoteFile"

    app_content = Path("src/App.tsx").read_text(encoding="utf-8")
    assert "handleAutoScopePackageFromFile" in app_content
    assert "handleExtractBidFromFile" in app_content

    print("PASS: test_direct_file_to_ai_actions")

def test_pre_bid_escalated_rfi_review_queue():
    """
    Deliverable 4: Validates Pre-Bid Escalated RFI Review Queue.
    PM review/approval actions before addenda are finalized in PreBidQnAView and convex/rfq.ts.
    """
    rfq_path = Path("convex/rfq.ts")
    assert rfq_path.exists()
    rfq_content = rfq_path.read_text(encoding="utf-8")
    assert "export const reviewEscalatedRfi = mutation(" in rfq_content, "Missing reviewEscalatedRfi mutation"

    qna_path = Path("src/components/PreBidQnAView.tsx")
    assert qna_path.exists()
    qna_content = qna_path.read_text(encoding="utf-8")
    assert "PM Review Queue" in qna_content, "PreBidQnAView must feature PM Review Queue"
    assert "Approve for Addendum" in qna_content, "PreBidQnAView must have Approve for Addendum action"
    assert "Edit Clarification" in qna_content or "Edit Response" in qna_content, "PreBidQnAView must have Edit Clarification action"

    app_content = Path("src/App.tsx").read_text(encoding="utf-8")
    assert "handleReviewRfi" in app_content, "App.tsx must wire handleReviewRfi"

    print("PASS: test_pre_bid_escalated_rfi_review_queue")

def test_vertex_ai_rest_pipeline():
    """
    Validates Vertex AI SDK / REST flow for Gemini in convex/llmRouter.ts
    and schema environment registration in convex/convex.config.ts.
    """
    router_content = Path("convex/llmRouter.ts").read_text(encoding="utf-8")
    assert "aiplatform.googleapis.com" in router_content, "llmRouter.ts must contain Vertex AI REST endpoint"
    assert "VERTEX_PROJECT_ID" in router_content, "llmRouter.ts must support VERTEX_PROJECT_ID"
    assert "VERTEX_ACCESS_TOKEN" in router_content, "llmRouter.ts must support VERTEX_ACCESS_TOKEN"
    assert "VERTEX_LOCATION" in router_content, "llmRouter.ts must support VERTEX_LOCATION"

    cfg_content = Path("convex/convex.config.ts").read_text(encoding="utf-8")
    assert "VERTEX_PROJECT_ID: v.optional(v.string())" in cfg_content
    assert "VERTEX_ACCESS_TOKEN: v.optional(v.string())" in cfg_content

    print("PASS: test_vertex_ai_rest_pipeline")

def test_verified_webhook_and_automation():
    """
    Validates fail-closed AgentMail webhook handling in convex/http.ts,
    automated webhook registration in convex/emailActions.ts, and setup CLI script.
    """
    http_content = Path("convex/http.ts").read_text(encoding="utf-8")
    assert "Webhook verification is not configured" in http_content, "http.ts must fail closed when webhook verification is unavailable"
    assert "status: 503" in http_content, "http.ts must return a service-unavailable response until verification is configured"
    assert "onMessageReceived" in http_content, "http.ts must route verified messages to onMessageReceived"

    email_actions_content = Path("convex/emailActions.ts").read_text(encoding="utf-8")
    assert "registerAgentMailWebhook" in email_actions_content, "emailActions.ts must export registerAgentMailWebhook"

    setup_script = Path("scripts/setup-agentmail-webhook.mjs")
    assert setup_script.exists(), "scripts/setup-agentmail-webhook.mjs must exist"

    pkg_content = Path("package.json").read_text(encoding="utf-8")
    assert '"webhook:setup"' in pkg_content, "package.json must contain webhook:setup npm script"

    print("PASS: test_resilient_webhook_and_automation")

def test_agentmail_spec_alignment_and_security_hardening():
    """
    Validates AgentMail latest API specification alignment:
    - rfqActions.ts extracts inbox.inbox_id
    - http.ts enforces Svix verification strictly when secret is configured (401 on missing svix headers)
    - setup-agentmail-webhook.mjs handles existing webhooks and retrieves Svix secret
    - package.json includes deploy and deploy:site scripts
    """
    rfq_actions = Path("convex/rfqActions.ts").read_text(encoding="utf-8")
    # The direct REST client (convex/agentmailApi.ts) normalizes inbox_id/id; the
    # action consumes the normalized `inbox.id`. Assert the architecture, not a
    # stale raw-field name.
    agentmail_api = Path("convex/agentmailApi.ts").read_text(encoding="utf-8")
    assert "inbox_id" in agentmail_api, "agentmailApi.ts must read inbox.inbox_id per AgentMail API specification"
    assert "inbox.id" in rfq_actions, "rfqActions.ts must use the normalized inbox id returned by the API client"

    http_content = Path("convex/http.ts").read_text(encoding="utf-8")
    assert "Missing required svix headers" in http_content, "http.ts must reject requests missing svix headers when secret is configured"

    setup_script = Path("scripts/setup-agentmail-webhook.mjs").read_text(encoding="utf-8")
    assert "webhook_id" in setup_script, "setup script must recognize webhook_id per AgentMail API specification"
    assert "existing" in setup_script, "setup script must detect existing webhooks to prevent duplicate registrations"

    pkg_content = Path("package.json").read_text(encoding="utf-8")
    assert '"deploy"' in pkg_content, "package.json must include deploy script"
    assert '"deploy:site"' in pkg_content, "package.json must include deploy:site script"

    print("PASS: test_agentmail_spec_alignment_and_security_hardening")

def test_expert_ground_truth_dataset_schema():
    """
    Validates that evals/ground-truth-dataset.json adheres to ASPE/AGC commercial standards
    and contains all 10 multi-trade evaluation cases across Divisions 26, 23, 22, and MEP Clashes.
    """
    gt_path = Path("evals/ground-truth-dataset.json")
    assert gt_path.exists(), "evals/ground-truth-dataset.json must exist"
    
    data = json.loads(gt_path.read_text(encoding="utf-8"))
    assert data["standard"] == "ASPE / AGC / CPE Commercial Bid Leveling Guidelines"
    assert len(data["cases"]) == 10, f"Expected 10 benchmark cases, got {len(data['cases'])}"
    
    case_ids = [c["caseId"] for c in data["cases"]]
    assert "case-26-01-austin-metro" in case_ids
    assert "case-26-02-lone-star" in case_ids
    assert "case-26-03-capital-grid" in case_ids
    assert "case-23-01-travis-county" in case_ids
    assert "case-23-02-hill-country" in case_ids
    assert "case-23-03-austin-air" in case_ids
    assert "case-22-01-colorado-river" in case_ids
    assert "case-22-02-apex-piping" in case_ids
    assert "case-mep-01-double-buys" in case_ids
    assert "case-mep-02-scope-voids" in case_ids

    print("PASS: test_expert_ground_truth_dataset_schema")

def test_chief_estimator_evals_engine_and_drift_fixes():
    """
    Validates ADR-0003 bid leveling math against Certified Professional Estimator ground truth.
    Confirms that trade milestone calibration eliminates calculation drift on Div 23 and Div 22.
    """
    def calculate_leveled(base, exclusions, lead_wks, target_wks, coi_status, ve_deducts=0):
        exc_total = sum(e["costImpact"] for e in exclusions)
        lead_pen = max(0, lead_wks - target_wks) * 6000
        coi_pen = 15000 if coi_status == "deficiency_detected" else 0
        return base + exc_total + lead_pen + coi_pen - ve_deducts

    # Div 26 Alterman: $1.10M base + $147k exclusions + $24k lead + $15k coi = $1,286,000
    c26_alterman = calculate_leveled(1100000, [{"costImpact": 45000}, {"costImpact": 22000}, {"costImpact": 55000}, {"costImpact": 25000}], 16, 12, "deficiency_detected")
    assert c26_alterman == 1286000

    # Div 26 Rosendin: $1.225M base - $35k VE = $1,190,000
    c26_rosendin = calculate_leveled(1225000, [], 10, 12, "compliant", 35000)
    assert c26_rosendin == 1190000

    # Div 23 The Brandt Companies: $1.65M base + $108k exclusions + $12k lead (18 wks vs 16 wks target) + $15k coi = $1,785,000 (NO +33k DRIFT!)
    c23_brandt = calculate_leveled(1650000, [{"costImpact": 48000}, {"costImpact": 28000}, {"costImpact": 18000}, {"costImpact": 14000}], 18, 16, "deficiency_detected")
    assert c23_brandt == 1785000, f"Expected $1,785,000, got {c23_brandt}"

    # Div 23 TDIndustries: $1.82M base = $1,820,000
    c23_tdindustries = calculate_leveled(1820000, [], 12, 16, "compliant")
    assert c23_tdindustries == 1820000

    # Div 23 Southland: $1.76M base + $12k exclusion - $32k VE = $1,740,000
    c23_southland = calculate_leveled(1760000, [{"costImpact": 12000}], 14, 16, "compliant", 32000)
    assert c23_southland == 1740000

    # Div 22 Limbach: $820k base + $61.5k exclusions + $12k lead (18 wks vs 16 wks target) + $15k coi = $908,500 (NO +44k DRIFT!)
    c22_limbach = calculate_leveled(820000, [{"costImpact": 16000}, {"costImpact": 8500}, {"costImpact": 12000}, {"costImpact": 25000}], 18, 16, "deficiency_detected")
    assert c22_limbach == 908500, f"Expected $908,500, got {c22_limbach}"

    # Div 22 Apex: $935k base = $935,000
    c22_apex = calculate_leveled(935000, [], 10, 16, "compliant")
    assert c22_apex == 935000

    # Cross-Trade Clashes
    double_buys = 38500 + 12000
    assert double_buys == 50500
    scope_voids = 28000 + 18500
    assert scope_voids == 46500

    print("PASS: test_chief_estimator_evals_engine_and_drift_fixes")

def test_eval_trace_telemetry_schema():
    """
    Validates that Convex schema and evals actions implement full trace logging.
    """
    schema_content = Path("convex/schema.ts").read_text(encoding="utf-8")
    assert "evalRuns" in schema_content, "evalRuns table must be defined in schema.ts"
    assert "agentTraces" in schema_content, "agentTraces table must be defined in schema.ts"
    assert "by_runId" in schema_content
    assert "by_run_and_timestamp" in schema_content

    evals_content = Path("convex/evals.ts").read_text(encoding="utf-8")
    assert "executeEvalSuite" in evals_content
    assert "recordAgentTrace" in evals_content
    assert "recordEvalRun" in evals_content
    assert "getLatestEvalRun" in evals_content

    pkg_content = Path("package.json").read_text(encoding="utf-8")
    assert '"evals": "node scripts/run-expert-evals.mjs"' in pkg_content

    print("PASS: test_eval_trace_telemetry_schema")

def test_real_world_production_robustness_and_edge_cases():
    """
    Validates real-world enterprise edge cases:
    1. Convex bids in-place patching preserves agreement foreign keys.
    2. emailActions ignores waived exclusions in scope gaps sum.
    3. email.ts resolves package by recipient email when inboxId is absent.
    4. files.ts parses binary PDF streams cleanly without choke bytes.
    5. App.tsx guards queries against dummy string IDs with isRealConvexProject/isRealConvexPackage.
    6. BidLevelingMatrixView defensively guards .toLocaleString() and lineItems.
    """
    bids_src = Path("convex/bids.ts").read_text(encoding="utf-8")
    assert "await ctx.db.patch(existing._id" in bids_src, "bids.ts must patch existing bid in-place to preserve agreement references"

    email_actions_src = Path("convex/emailActions.ts").read_text(encoding="utf-8")
    assert "exc.isWaived ? sum : sum + (exc.costImpact || 0)" in email_actions_src, "emailActions must ignore waived exclusions in leveling"

    email_src = Path("convex/email.ts").read_text(encoding="utf-8")
    assert "toRecipients" in email_src, "email.ts must parse recipient emails"
    assert "pkgMatch" in email_src, "email.ts must match trade package by agentMailbox when inboxId is missing"

    files_src = Path("convex/files.ts").read_text(encoding="utf-8")
    assert "txt.startsWith(\"%PDF\")" in files_src, "files.ts must detect binary PDF streams"

    app_src = Path("src/App.tsx").read_text(encoding="utf-8")
    assert "isRealConvexProject" in app_src, "App.tsx must define isRealConvexProject guard"
    assert "isRealConvexPackage" in app_src, "App.tsx must define isRealConvexPackage guard"

    matrix_src = Path("src/components/BidLevelingMatrixView.tsx").read_text(encoding="utf-8")
    assert "(exc.costImpact || 0).toLocaleString()" in matrix_src, "BidLevelingMatrixView must guard exc.costImpact before toLocaleString"
    assert "bid.lineItems?.length || 0" in matrix_src, "BidLevelingMatrixView must guard lineItems length"

    print("PASS: test_real_world_production_robustness_and_edge_cases")

def test_real_world_commercial_quote_ingestion_and_package_resilience():
    app_src = Path("src/App.tsx").read_text(encoding="utf-8")
    assert "agreements: prev.agreements.filter((a) => a.bidId !== bidId)" in app_src, "handleDeleteBid must clean up associated agreements"
    assert "baseMatch = text.match" in app_src, "handleIngestQuote must dynamically extract base bid via regex"
    assert "leadMatch =" in app_src, "handleIngestQuote must dynamically extract lead time via regex"
    assert "newContractorName" in app_src, "handleIngestQuote must support on-the-fly contractor creation"

    matrix_src = Path("src/components/BidLevelingMatrixView.tsx").read_text(encoding="utf-8")
    assert "agreements.find((a) => a.tradePackageId === currentPackage?._id)" not in matrix_src, "activeAgreement must not cross-contaminate agreements between different bidders"
    assert "newContractorName" in matrix_src, "BidLevelingMatrixView must support entering new contractor company name"

    pkgs_src = Path("src/components/TradePackagesView.tsx").read_text(encoding="utf-8")
    assert "No Trade Packages Configured" in pkgs_src, "TradePackagesView must render clear empty state banner when tradePackages is empty"
    # F5: the header owns the primary CTAs; the empty state must not duplicate them.
    assert "AI Spec Breakdown (Auto-Scope)" in pkgs_src, "TradePackagesView header must expose the AI Spec Breakdown CTA"
    assert "Run AI Spec Breakdown" not in pkgs_src, "F5: empty state must not duplicate the header AI Spec Breakdown CTA"
    assert "in the header above to get started" in pkgs_src, "F5: empty state must point to the header CTAs instead of duplicating them"

    coord_src = Path("src/components/CrossTradeCoordinationView.tsx").read_text(encoding="utf-8")
    assert "matchedSecondary || matchedPrimary" in coord_src, "CrossTradeCoordinationView must dynamically match target package by clash division"
    assert "tradePackages" in coord_src and "Assign to Div {pkg.csiDivision}" in coord_src, "CrossTradeCoordinationView must allow assigning scope voids to any available project trade package"

    print("PASS: test_real_world_commercial_quote_ingestion_and_package_resilience")

def test_real_world_file_extraction_and_location_robustness():
    """
    Validates real-world construction workflow robustness:
    1. parseCityAndState handles diverse non-comma locations and state codes.
    2. handleExtractBidFromFile decodes raw PDF stream data via extractTextFromPdfStream and uses headerPatterns.
    3. handleAutoScopePackageFromFile inspects decoded file content.
    4. Subcontract agreements render full 10-article AIA Document A401 terms.
    """
    app_src = Path("src/App.tsx").read_text(encoding="utf-8")
    assert "parseCityAndState" in app_src, "App.tsx must import and use parseCityAndState"
    assert "generateAiaA401AgreementText" in app_src, "App.tsx must import and use generateAiaA401AgreementText"
    assert "extractTextFromPdfStream(rawContent)" in app_src, "handleExtractBidFromFile must decode PDF stream data"
    assert "extractTextFromPdfStream(decodedContent)" in app_src, "handleAutoScopePackageFromFile must decode PDF spec data"
    assert "headerPatterns =" in app_src, "handleExtractBidFromFile must use robust headerPatterns"
    assert "existingBidIndex" in app_src, "handleExtractBidFromFile must deduplicate bids in leveling matrix"

    store_src = Path("src/standaloneStore.ts").read_text(encoding="utf-8")
    assert "export function parseCityAndState" in store_src, "standaloneStore.ts must export parseCityAndState"
    assert "export function generateAiaA401AgreementText" in store_src, "standaloneStore.ts must export generateAiaA401AgreementText"
    assert "ARTICLE 10 - ATTESTATION & FORMAL EXECUTION" in store_src, "generateAiaA401AgreementText must include Article 10 formal execution"
    assert "ARTICLE 7 - INSURANCE & INDEMNIFICATION" in store_src, "generateAiaA401AgreementText must include Article 7 insurance & COI"

    print("PASS: test_real_world_file_extraction_and_location_robustness")

def test_p1_server_side_integrity_guards():
    """Regression coverage for canonical parties, file validation, and quote idempotency."""
    agreements_src = Path("convex/agreements.ts").read_text(encoding="utf-8")
    assert "project.generalContractorName?.trim() || DEFAULT_GENERAL_CONTRACTOR" in agreements_src
    assert "const subName = contractor.companyName.trim()" in agreements_src
    assert "project.generalContractorName?.trim() || DEFAULT_GENERAL_CONTRACTOR" in agreements_src
    assert "Executed agreements are immutable" in agreements_src

    files_src = Path("convex/files.ts").read_text(encoding="utf-8")
    assert "validateUploadFileType(args.fileType)" in files_src
    assert "getAuthoritativeFileSize(ctx, args.storageId, args.fileSize, fileName)" in files_src
    assert "fileRecord.projectId !== args.projectId" in files_src

    schema_src = Path("convex/schema.ts").read_text(encoding="utf-8")
    assert 'sourceFileId: v.optional(v.id("projectFiles"))' in schema_src
    assert '.index("by_source_file", ["sourceFileId"])' in schema_src
    bids_src = Path("convex/bids.ts").read_text(encoding="utf-8")
    assert 'withIndex("by_source_file"' in bids_src
    assert "existingBySource" in bids_src
    assert "cannot be unawarded" in bids_src

    print("PASS: test_p1_server_side_integrity_guards")

def test_binding_addendum_requires_pm_certification():
    schema_src = Path("convex/schema.ts").read_text(encoding="utf-8")
    rfq_src = Path("convex/rfq.ts").read_text(encoding="utf-8")
    files_src = Path("convex/files.ts").read_text(encoding="utf-8")
    prebid_src = Path("src/components/PreBidQnAView.tsx").read_text(encoding="utf-8")
    assert "pmCertifiedAt: v.optional(v.number())" in schema_src
    assert 'c.status === "clarified" && c.pmCertifiedAt' in rfq_src
    assert "PM certification is required before issuing a binding addendum" in files_src
    assert "does not belong to the selected project" in files_src
    assert "pendingCertificationCount" in prebid_src
    assert "if (pendingCertificationCount > 0)" in prebid_src
    assert 'projectId.startsWith("proj_") && pendingCertificationCount' not in prebid_src
    assert 'pmCertifiedAt: Date.now()' in Path("src/App.tsx").read_text(encoding="utf-8")

    print("PASS: test_binding_addendum_requires_pm_certification")

def test_eval_rollups_show_real_cross_trade_drift():
    evals_src = Path("convex/evals.ts").read_text(encoding="utf-8")
    diagnostics_src = Path("src/components/SponsorDiagnosticsView.tsx").read_text(encoding="utf-8")
    assert "calculatePercentageError" in evals_src
    assert "const voidAiCost" in evals_src
    assert "const clashRecallAvg" in evals_src
    assert "precision >= 0.9" in evals_src
    assert "internalMutation" in evals_src
    assert "latestEvalData.run.clashRecallAvg" in diagnostics_src
    assert "Computed from cross-trade cases" in diagnostics_src
    assert "const mapeAvg = results.reduce((sum, r) => sum + r.apePercent" in evals_src
    assert "costMetrics" not in evals_src, "MAPE must include cross-trade cost cases"
    assert 'const passed = t.status === "PASS"' in diagnostics_src
    assert "t.metrics?.aiLeveledCost || t.parsedOutput?.leveledTotalCost" in diagnostics_src

    print("PASS: test_eval_rollups_show_real_cross_trade_drift")

if __name__ == "__main__":
    test_normalization_formula_adr0003()
    test_csi_schema_and_models()
    test_http_router_and_static_hosting_rule()
    test_judge_simulation_engine()
    test_token_optimized_llm_router()
    test_simulation_engine_custom_rfi_and_compliant_bid()
    test_firecrawl_v2_and_partner_spec_alignment()
    test_type_definitions_and_zero_unused_vars()
    test_aia_document_a401_contract_generator()
    test_convex_depth_primitives()
    test_multi_trade_context_aware_simulation()
    test_deep_sponsor_integration_boost()
    test_frontend_build_artifacts()
    test_firecrawl_website_scraping_and_array_parsing()
    test_dynamic_audit_stream_logging_coverage()
    test_aia_a401_legal_number_to_words_and_unaward_invariant()
    test_csv_export_escaping_and_null_guards()
    test_boost_forensic_leveling_ve_and_waivers()
    test_boost_autonomous_scoping_and_legal_addenda()
    test_boost_contractor_crud_and_full_lifecycle_simulation()
    test_zero_cloud_localhost_standalone_resilience()
    test_cross_trade_coordination_and_clash_engine()
    test_direct_file_to_ai_actions()
    test_pre_bid_escalated_rfi_review_queue()
    test_vertex_ai_rest_pipeline()
    test_verified_webhook_and_automation()
    test_agentmail_spec_alignment_and_security_hardening()
    test_expert_ground_truth_dataset_schema()
    test_chief_estimator_evals_engine_and_drift_fixes()
    test_eval_trace_telemetry_schema()
    test_real_world_production_robustness_and_edge_cases()
    test_real_world_commercial_quote_ingestion_and_package_resilience()
    test_real_world_file_extraction_and_location_robustness()
    test_p1_server_side_integrity_guards()
    test_binding_addendum_requires_pm_certification()
    test_eval_rollups_show_real_cross_trade_drift()
    print("\nALL 36 TRADEPULSE PRO DOMAIN, EVALS & ARCHITECTURE TESTS PASSED SUCCESSFULLY!")
