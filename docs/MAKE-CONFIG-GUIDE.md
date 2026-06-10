# Make.com Configuration Guide
## Axiom Drawing Flow — Changes Required

**Date:** 2026-06-09  
**Relates to:** Bug 1 (suffix folder link in emails) + Feature 3 (DT summary email)  
**Scenario:** Scenario 2 — Actions Hub (ID 5993716)

All changes are in the single consolidated Actions Hub scenario.  
The Ingest scenario (ID 5993712) is unchanged.

---

## Before you start

Open Make → your workspace → Scenario 2 (Actions Hub).  
Click **Edit** to enter the scenario editor.  
The Router module currently has routes for: `approve`, `bounce`, `issue`, `log-status`.

---

## Part 1 — Bug 1: Suffix Folder Link in Emails

The backend now sends two new fields in the webhook payload:

| Action | New field | Value |
|--------|-----------|-------|
| `approve` | `suffixFolderPath` | e.g. `/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions/24-367/S4/Suffix 003` |
| `bounce`  | `bounceFolderPath` | e.g. `/DESIGN KNOW HOW/TMJ Interiors/Drawing Submissions/24-367/S4/Rejected/R2/Suffix 003` |

---

### 1A — Approve route: add shared link module

1. In the Router, find the **Approve** route.
2. The route currently has two modules: **Dropbox: Move a File** → **Gmail: Send an Email**.
3. Click the **+** button between "Move a File" and "Gmail" to insert a new module.
4. Search for **Dropbox** → select **Create/Update a Shared Link**.
5. Configure:
   - **Connection:** your existing Dropbox connection
   - **File Path:** `{{1.suffixFolderPath}}`
   - **Shared link type:** `Preview` (or `Direct` — either works for a folder link)
6. Click **OK** to save the module. Make assigns it a number (e.g. module 5).
7. Open the **Gmail: Send an Email** module in this route.
8. Update the **Body** to include the folder link. Replace the current body with:

```
Hi {{1.dtName}},

Drawing {{1.submissionTitle}} has passed QA review ({{1.stage}}).

Your upload folder for final DWGs:
{{5.url}}

Suffix ref: {{1.suffixRef}}
Reviewed: {{formatDate(1.reviewedAt; "D MMM YYYY")}}

— Axiom Drawing Management
```

> Replace `{{5.url}}` with the actual module number assigned to your "Create/Update a Shared Link" module. If Make assigned it module 6, use `{{6.url}}`.

---

### 1B — Bounce route: update Gmail body link label

The "Create/Update a Shared Link" module is **already in place** (module 19) and the Gmail body
template is already correctly wired. Only the **link label text** needs updating.

**About the "and" you see in the screenshot**

The word `and` shown between coloured pills in Make's visual editor is **not syntax** — it is
Make's display rendering for adjacent mapped variables concatenated together inside a text field.
You never type the word "and". When you insert variable tokens next to each other (or next to
plain text), Make simply shows them joined by "and" in the visual view. The underlying template
is just the tokens placed adjacently.

**What the current body does (confirmed from screenshot):**
- Extracts the drawing name from `1.dropboxMove.from` using `last(split(1.dropboxMove.from; "/"))`
- Shows stage, QA round, bouncedAt
- Conditionally renders a Miro board link via `if(1.miroLink; ...)`
- Renders the folder link as an anchor: href = `19.URL`, label = `"Open R-folder in Dropbox"`

**The one change required:** update the anchor link label from `Open R-folder in Dropbox` to show
the actual folder path so the DT sees exactly where their annotated file is.

1. Open the **Bounce** route's **Gmail: Send an Email** module.
2. Scroll to the folder link block near the bottom of the body. In the visual editor it looks like:

   > `if(` **19.URL** `; <p><strong>Review Folder: </strong><a href="` **and** **19.URL** **and** `">Open R-folder in Dropbox</a></p> ; "" )`

   The `and` here is just Make's visual display — the actual content is: the href attribute is
   set to the `19.URL` token, and the link label is the plain text `Open R-folder in Dropbox`.

3. Click inside the label text (between `">` and `</a>`) and replace `Open R-folder in Dropbox`
   with the following — inserting each variable as a **token pill**, not typed text:

   | Type | Content |
   |------|---------|
   | Plain text | `Rejected/R` |
   | Token (pill) | `1.qaRound` |
   | Plain text | `/Suffix ` |
   | Token (pill) | `1.dropboxMove.itemNo` |

   The visual editor will then display this as:
   > `Rejected/R` **1.qaRound** `/Suffix ` **1.dropboxMove.itemNo**

   Which renders in the sent email as e.g.: `Rejected/R2/Suffix 003`

4. Click **OK** to save.

**No other changes needed to the bounce route** — module 19 is already correctly generating
the shared link from the bounce destination folder.

---

## Part 2 — Feature 3: DT Summary Email Route

The backend now sends a new `action = "dt-summary"` webhook from the `POST /api/df/send-dt-emails` endpoint. This fires once per DT with an array of all their pending submissions.

You need to add a new route to the Router for this action.

---

### 2A — Add the dt-summary Router route

1. In the Router module, click **Add route**.
2. Set the **Filter** for this route:
   - Label: `DT Summary Email`
   - Condition: `{{1.action}}` **Equal to (text)** `dt-summary`

---

### 2B — Add an Iterator module

The payload contains a `submissions` array. Make's `map()` function can only extract **one field at a time** — it cannot concatenate multiple fields into an HTML string inside a single expression. To build a multi-column HTML table row per submission, you need an **Iterator + Text Aggregator** pipeline.

**Module order for the dt-summary route:**

```
Router (dt-summary filter)
  → Iterator
  → Text Aggregator (HTML rows)
  → Gmail: Send an Email
```

---

#### Why the table may be empty — re-ingest the data structure first

Make learns the shape of a webhook payload the **first time it receives it**. If the scenario
was built before `send-dt-emails` existed, Make does not yet know that module 1 outputs a
`submissions` array of objects. The Iterator therefore has nothing to unpack and the Text
Aggregator produces empty rows.

**You must re-teach Make the data structure before mapping the Iterator fields:**

1. In the scenario editor, click on the **Webhook** trigger module (module 1).
2. Click **Re-determine data structure**.
3. Leave this dialog open — Make is now listening.
4. Go to the cockpit, uncheck `DT Notified` on one or two Submissions in Notion, then click
   **Send DT Emails**. This fires a live `dt-summary` webhook payload to Make.
5. Make detects the payload and shows "Successfully determined" — click **OK**.
6. Module 1 now knows the full structure including `submissions[]` with all its child fields.

After this, open the **Iterator** module — the `Array` field dropdown will now show
`1.submissions` as a selectable mapped array. Select it and save.

Then open the **Text Aggregator** — the field picker will show the Iterator's output fields
(`drawingNo`, `stage`, `actionLabel`, `folderPath`, etc.) as selectable tokens. Re-map them.

---

#### Step 1 — Iterator

1. Add **Flow Control → Iterator** to the dt-summary route (or open the existing one).
2. Configure:
   - **Array:** click the field, select `{{1.submissions}}` from the mapped data panel
     (only visible after re-ingesting the data structure above)
3. Click **OK**.

The Iterator outputs one submission bundle at a time. Note the module number Make assigned
(visible in the top-left corner of the module bubble) — you'll use it in the next step.

---

#### Step 2 — Text Aggregator (builds the table rows)

1. Add **Flow Control → Text Aggregator** after the Iterator (or open the existing one).
2. Configure:
   - **Source module:** select the Iterator module from the dropdown
   - **Text:** Build the row by clicking into the field and selecting each token from the
     mapped data panel. The Iterator's output fields (`drawingNo`, `stage`, `actionLabel`,
     `folderPath`) will appear under the Iterator's module number in the panel.

     The completed Text field should look like this (using the Iterator's module number,
     shown here as `N` — yours is `29`):

```html
<tr>
  <td style="padding:8px;border:1px solid #ddd;">{{N.drawingNo}}</td>
  <td style="padding:8px;border:1px solid #ddd;">{{N.stage}}</td>
  <td style="padding:8px;border:1px solid #ddd;">{{N.actionLabel}}</td>
  <td style="padding:8px;border:1px solid #ddd;">{{N.folderHtml}}</td>
</tr>
```

   **The fourth `<td>` is the Folder column.** Replace everything between `>` and `</td>`
   in that cell with a single `{{N.folderHtml}}` token pill.

   - `folderHtml` is a pre-built HTML anchor string from the backend, e.g.:
     `<a href="https://www.dropbox.com/home/DESIGN%20KNOW%20HOW/...">Suffix 112</a>`
   - The link label is just the last folder segment (**Suffix 112**, **R1**, etc.)
   - The URL has all spaces encoded as `%20` so it doesn't break in email clients
   - If no folder exists the backend sends `—` so no Make `if()` function is needed

   **Do not use `if()`, `ifempty()`, or any Make function in this cell.** Make functions
   do not evaluate inside Text Aggregator text blocks — they render as literal text.
   All logic is handled in the backend before the webhook fires.

   - **Row separator:** leave blank

3. Click **OK**. The aggregator outputs a single `text` variable.

> **Do not type `N` literally.** Select each field as a token pill from the mapped data panel.
> The number Make shows is auto-assigned — based on your scenario it is `29`.
>
> **After deploying the backend** re-run **Re-determine data structure** on the webhook trigger
> (fire one Send DT Emails from the cockpit) so Make learns the new `folderHtml` field.
> Then come back and replace the fourth `<td>` content with the `29.folderHtml` token pill.

---

#### Step 3 — Gmail: Send an Email

1. Add **Gmail → Send an Email** after the Text Aggregator (or open the existing one).
2. Configure:
   - **To:** `{{1.dtEmail}}`
   - **Subject:** `Drawing Flow Update — {{1.count}} drawing(s) actioned`
   - **Content type:** HTML
   - **Body:** Build the body, inserting the Text Aggregator's `text` output token into
     the `<tbody>`. The Text Aggregator's output appears in the mapped data panel under
     its module number.

```html
<p>Hi {{1.dtName}},</p>

<p>The following drawings have been actioned and require your attention:</p>

<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:13px;">
  <thead>
    <tr style="background:#f0f0f0;">
      <th style="padding:8px;border:1px solid #ddd;text-align:left;">Drawing</th>
      <th style="padding:8px;border:1px solid #ddd;text-align:left;">Stage</th>
      <th style="padding:8px;border:1px solid #ddd;text-align:left;">Action</th>
      <th style="padding:8px;border:1px solid #ddd;text-align:left;">Folder</th>
    </tr>
  </thead>
  <tbody>
    {{TextAggregator.text}}
  </tbody>
</table>

<p style="margin-top:16px;font-size:12px;color:#666;">
  — Axiom Drawing Management<br>
  Actioned: {{formatDate(now; "D MMM YYYY HH:mm")}}
</p>
```

   > `{{TextAggregator.text}}` is a placeholder — select the actual `text` token from the
   > Text Aggregator module in the mapped data panel. Do not type it literally.
   > `{{1.dtName}}` and `{{1.count}}` reference the original webhook payload (module 1) and
   > are typed/selected normally.

3. Click **OK**.

---

## Part 3 — Removing old individual email routes

The `approve`, `bounce`, `issue`, and `log-status` routes in the Router **no longer receive webhook calls from the backend** (those `fireWebhook` calls have been removed from the code). The routes will never fire.

You have two options:
- **Leave them in place** — they're harmless dead routes; no webhook will reach them.
- **Delete them** — cleaner, reduces clutter. Safe to do once you've confirmed the `dt-summary` route is working in testing.

Recommendation: leave them for now, delete after your first successful end-to-end test.

---

## Part 4 — Testing checklist

After saving and activating the updated scenario:

- [ ] In the cockpit, approve one submission. Verify it appears in the "Pending DT Notification" section.
- [ ] Bounce one submission. Verify it also appears in "Pending DT Notification".
- [ ] Click "Send DT Emails" in the cockpit. Verify the section clears immediately.
- [ ] Check the DT's inbox — one email should arrive listing all actioned drawings.
- [ ] Open the folder link in the approve email — verify it opens the correct Dropbox Suffix folder.
- [ ] Open the folder link in the bounce content — verify it shows the correct `Rejected/Rn/Suffix nnn` folder.
- [ ] In Notion Submissions DB, verify the `DT Notified` checkbox is `true` for all notified submissions.

---

## Notion prerequisite (do this first)

Before deploying the updated code, add the following property to the **Submissions DB** in Notion:

| Property name | Type |
|---------------|------|
| `DT Notified` | Checkbox |

Steps:
1. Open the Submissions DB in Notion.
2. Click **+** to add a new property.
3. Set name: `DT Notified`
4. Set type: **Checkbox**
5. Leave default value as unchecked (false).

All existing submissions will default to unchecked — which is correct. The send-dt-emails endpoint only reads submissions where this is false, so pre-existing data won't cause spurious emails.
