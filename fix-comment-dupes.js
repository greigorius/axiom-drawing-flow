const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DRAWINGS_DB = process.env.NOTION_DB_DRAWINGS || "13b210e4582e8168923ff79fa8628b59";
const COMMENT_PROPS = ["S4 Comment Files", "S5 Comment Files", "A4.5 Comment Files"];

async function queryAll(dbId) {
  const pages = [];
  let cursor;
  do {
    const r = await notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 });
    pages.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return pages;
}

function dedupeRT(rt) {
  const seen = new Set();
  const out = [];
  // Collect non-separator segments in order, skip duplicates
  const segments = rt.filter(r => !( r.text?.content === ", " || r.text?.content === " "));
  const separators = [];
  let changed = false;
  segments.forEach((seg, i) => {
    const key = seg.text?.content ?? "";
    if (!seen.has(key)) {
      seen.add(key);
      if (out.length > 0) out.push({ type: "text", text: { content: ", " } });
      out.push(seg);
    } else {
      changed = true;
    }
  });
  return { deduped: out, changed };
}

(async () => {
  const pages = await queryAll(DRAWINGS_DB);
  let fixed = 0;
  for (const page of pages) {
    const updates = {};
    for (const prop of COMMENT_PROPS) {
      const rt = page.properties?.[prop]?.rich_text ?? [];
      if (!rt.length) continue;
      const { deduped, changed } = dedupeRT(rt);
      if (changed) updates[prop] = { rich_text: deduped };
    }
    if (Object.keys(updates).length) {
      await notion.pages.update({ page_id: page.id, properties: updates });
      const title = page.properties?.["Drawing Number"]?.title?.[0]?.text?.content ?? page.id;
      console.log(`Fixed: ${title} →`, Object.keys(updates).join(", "));
      fixed++;
    }
  }
  console.log(`\nDone. Fixed ${fixed} drawing(s).`);
})();
