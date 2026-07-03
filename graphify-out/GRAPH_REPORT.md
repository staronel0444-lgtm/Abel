# Graph Report - .  (2026-07-03)

## Corpus Check
- Corpus is ~14,300 words - fits in a single context window. You may not need a graph.

## Summary
- 164 nodes · 337 edges · 14 communities (13 shown, 1 thin omitted)
- Extraction: 90% EXTRACTED · 10% INFERRED · 0% AMBIGUOUS · INFERRED: 35 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_AI Site Generation|AI Site Generation]]
- [[_COMMUNITY_Lead Prompt & Proposal UI|Lead Prompt & Proposal UI]]
- [[_COMMUNITY_Site Builder Frontend|Site Builder Frontend]]
- [[_COMMUNITY_Package Manifest & Scripts|Package Manifest & Scripts]]
- [[_COMMUNITY_Preview Storage & Serving|Preview Storage & Serving]]
- [[_COMMUNITY_Places Search & Product Overview|Places Search & Product Overview]]
- [[_COMMUNITY_Client CRUD API|Client CRUD API]]
- [[_COMMUNITY_Leads & History API|Leads & History API]]
- [[_COMMUNITY_Contact Form & Email Alerts|Contact Form & Email Alerts]]
- [[_COMMUNITY_Client Dashboard Frontend|Client Dashboard Frontend]]
- [[_COMMUNITY_Frontend Data Loading & Tabs|Frontend Data Loading & Tabs]]
- [[_COMMUNITY_Monthly Payment Tracking API|Monthly Payment Tracking API]]
- [[_COMMUNITY_Preview Item GetDelete API|Preview Item Get/Delete API]]
- [[_COMMUNITY_Revenue Aggregation API|Revenue Aggregation API]]

## God Nodes (most connected - your core abstractions)
1. `$()` - 22 edges
2. `HttpError` - 14 edges
3. `json()` - 14 edges
4. `readJson()` - 11 edges
5. `handle()` - 11 edges
6. `escapeHtml()` - 9 edges
7. `api()` - 9 edges
8. `renderClients()` - 9 edges
9. `toast()` - 8 edges
10. `switchTab()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `onRequestPost()` --calls--> `json()`  [EXTRACTED]
  functions/api/contact.js → lib/http.js
- `onRequestPost()` --calls--> `readJson()`  [EXTRACTED]
  functions/api/contact.js → lib/http.js
- `onRequestPost()` --calls--> `sendLeadEmail()`  [EXTRACTED]
  functions/api/contact.js → lib/email.js
- `wireForms()` --calls--> `injectForms()`  [EXTRACTED]
  functions/api/generate.js → lib/forminject.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **AI site generation flow** — readme_single_page_builder, readme_multi_page_builder, readme_refine, functions_api_generate, lib_anthropic, readme_stop_reason_truncation [INFERRED 0.80]
- **Lead-to-client lifecycle** — readme_lead_finder, readme_view_history, readme_client_dashboard, readme_revenue_dashboard [INFERRED 0.80]
- **Preview storage and serving** — readme_preview_links, readme_my_sites, functions_api_previews_index, functions_preview_path, readme_d1_database [INFERRED 0.80]

## Communities (14 total, 1 thin omitted)

### Community 0 - "AI Site Generation"
Cohesion: 0.18
Nodes (15): onRequestPost, wireForms(), buildSystem(), buildUserMessage(), extractHtml(), generate(), mapAnthropicError(), mockGenerate() (+7 more)

### Community 1 - "Lead Prompt & Proposal UI"
Cohesion: 0.12
Nodes (15): buildLeadPrompt(), buildState, clientState, leadCardHtml(), leadState, moneyFmt, moneyFmtCents, multiState (+7 more)

### Community 2 - "Site Builder Frontend"
Cohesion: 0.20
Nodes (16): $(), applyTheme(), copyText(), extractKeywords(), generateMulti(), generateSingle(), openHistoryDetail(), openMultiInBuilder() (+8 more)

### Community 3 - "Package Manifest & Scripts"
Cohesion: 0.14
Nodes (13): dependencies, @anthropic-ai/sdk, description, devDependencies, wrangler, name, private, scripts (+5 more)

### Community 4 - "Preview Storage & Serving"
Cohesion: 0.22
Nodes (9): onRequestGet, onRequestPost, HTML_HEADERS, notFound(), onRequestGet(), page(), randomId(), My Sites gallery (+1 more)

### Community 5 - "Places Search & Product Overview"
Cohesion: 0.23
Nodes (12): FIELD_MASK, humanizeType(), mockPlaces(), searchPlaces(), shapePlace(), Client Dashboard, D1 database, Forge (prompt-to-website builder) (+4 more)

### Community 6 - "Client CRUD API"
Cohesion: 0.24
Nodes (7): onRequestDelete, onRequestPut, onRequestGet, onRequestPost, parseCloseDate(), parseMoney(), shapeClient()

### Community 7 - "Leads & History API"
Cohesion: 0.38
Nodes (7): onRequestGet, onRequestPost, onRequestPost, handle(), json(), readJson(), requireString()

### Community 8 - "Contact Form & Email Alerts"
Cohesion: 0.33
Nodes (8): CORS, onRequestOptions(), onRequestPost(), withCors(), esc(), sendLeadEmail(), Contact-form alerts, HMAC-signed contact tokens

### Community 9 - "Client Dashboard Frontend"
Cohesion: 0.24
Nodes (10): buildInvoiceDoc(), formatDate(), formatMonth(), isDueThisMonth(), localCurrentMonth(), localToday(), markPaid(), money() (+2 more)

### Community 10 - "Frontend Data Loading & Tabs"
Cohesion: 0.47
Nodes (9): api(), createPreview(), escapeHtml(), initInvoice(), loadClients(), loadHistory(), loadRevenue(), loadSites() (+1 more)

### Community 11 - "Monthly Payment Tracking API"
Cohesion: 0.29
Nodes (4): currentMonth(), onRequestDelete, onRequestPost, parseMonth()

### Community 12 - "Preview Item Get/Delete API"
Cohesion: 0.33
Nodes (3): onRequestDelete, onRequestGet, HttpError

## Knowledge Gaps
- **43 isolated node(s):** `onRequestPut`, `onRequestDelete`, `onRequestPost`, `onRequestDelete`, `onRequestGet` (+38 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `HttpError` connect `Preview Item Get/Delete API` to `AI Site Generation`, `Preview Storage & Serving`, `Places Search & Product Overview`, `Client CRUD API`, `Leads & History API`, `Contact Form & Email Alerts`, `Monthly Payment Tracking API`, `Revenue Aggregation API`?**
  _High betweenness centrality (0.069) - this node is a cross-community bridge._
- **Why does `json()` connect `Leads & History API` to `AI Site Generation`, `Preview Storage & Serving`, `Client CRUD API`, `Contact Form & Email Alerts`, `Monthly Payment Tracking API`, `Preview Item Get/Delete API`, `Revenue Aggregation API`?**
  _High betweenness centrality (0.039) - this node is a cross-community bridge._
- **Why does `Preview Links` connect `Preview Storage & Serving` to `Preview Item Get/Delete API`, `Places Search & Product Overview`?**
  _High betweenness centrality (0.037) - this node is a cross-community bridge._
- **What connects `onRequestPut`, `onRequestDelete`, `onRequestPost` to the rest of the system?**
  _43 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Lead Prompt & Proposal UI` be split into smaller, more focused modules?**
  _Cohesion score 0.12280701754385964 - nodes in this community are weakly interconnected._
- **Should `Package Manifest & Scripts` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._