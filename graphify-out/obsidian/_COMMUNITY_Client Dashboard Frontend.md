---
type: community
members: 10
---

# Client Dashboard Frontend

**Members:** 10 nodes

## Members
- [[buildInvoiceDoc()]] - code - public/app.js
- [[formatDate()]] - code - public/app.js
- [[formatMonth()]] - code - public/app.js
- [[isDueThisMonth()]] - code - public/app.js
- [[localCurrentMonth()]] - code - public/app.js
- [[localToday()]] - code - public/app.js
- [[markPaid()]] - code - public/app.js
- [[money()]] - code - public/app.js
- [[openClientModal()]] - code - public/app.js
- [[renderClients()]] - code - public/app.js

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Client_Dashboard_Frontend
SORT file.name ASC
```

## Connections to other communities
- 10 edges to [[_COMMUNITY_Lead Prompt & Proposal UI]]
- 7 edges to [[_COMMUNITY_Frontend Data Loading & Tabs]]
- 3 edges to [[_COMMUNITY_Site Builder Frontend]]

## Top bridge nodes
- [[renderClients()]] - degree 9, connects to 3 communities
- [[markPaid()]] - degree 6, connects to 3 communities
- [[money()]] - degree 4, connects to 2 communities
- [[localToday()]] - degree 4, connects to 2 communities
- [[buildInvoiceDoc()]] - degree 4, connects to 2 communities