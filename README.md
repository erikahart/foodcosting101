# PlateMargin (latest version)

The full app: Profit Coach, recipe builder with AI drafting, supplies, invoices &
orders inbox, supplier connections, and white-label branding with multiple restaurants.

## Deploy to foodcosting101

**Best: GitHub** (shared data, PIN, AI all work)
1. Put everything in this folder at the top level of a GitHub repository.
2. Netlify > foodcosting101 > Site configuration > Build & deploy > Link repository.
   Leave Base directory empty and Publish directory as `.`
3. Deploy.

**Or drag-and-drop** (quick look only): drag this folder onto foodcosting101 > Deploys.
The app works, but each device keeps its own data and the AI buttons are off,
because drag-and-drop sites don't run the server functions.

## Settings (Netlify > Site configuration > Environment variables)

| Variable | What it does |
| --- | --- |
| `EDIT_PIN` | Required to save changes or use AI. Set this before sharing the link. |
| `ANTHROPIC_API_KEY` | Turns on recipe drafting and the weekly plan. From console.anthropic.com. |
| `ANTHROPIC_MODEL` | Optional; a different Claude model. |

Redeploy after changing them.

## Good to know

- Everyone using the site shares one copy of the data. If two people save at the
  same moment, the second is told and shown the latest; they redo their last change.
- **Reset demo** on the Brand & accounts page replaces the data for everyone.
- Supplier feeds (Sysco etc.) are still demo buttons here. The real feed pipeline
  is the separate `supplier-feeds` project and needs Supabase; connecting the two is the next build.
