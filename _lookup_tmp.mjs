import { readFileSync } from 'fs';
import { Client } from '@notionhq/client';

const envText = readFileSync('.env', 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DRAWINGS_DB = process.env.NOTION_DB_DRAWINGS;
const SUBMISSIONS_DB = process.env.NOTION_DB_SUBMISSIONS;

async function getDS(dbId) {
  const db = await notion.databases.retrieve({ database_id: dbId });
  return db.data_sources[0].id;
}

function titleOf(page) {
  const t = Object.values(page.properties).find(p => p.type === 'title');
  return t?.title?.map(x => x.plain_text).join('') ?? '(untitled)';
}

const drawDs = await getDS(DRAWINGS_DB);

for (const dno of ['24217', '24218', '34362', '34363']) {
  const r = await notion.dataSources.query({
    data_source_id: drawDs,
    filter: { property: 'Drawing Number', title: { contains: dno } },
  });
  for (const p of r.results) {
    const props = p.properties;
    console.log('---DRAWING---', dno, p.id);
    console.log('  title:', titleOf(p));
    console.log('  S4 Comment Files:', JSON.stringify(props['S4 Comment Files']?.rich_text?.map(t=>t.plain_text)));
    console.log('  S4 Status:', JSON.stringify(props['S4 Status']));
    console.log('  Item relation:', props['Item']?.relation?.map(r=>r.id));
    console.log('  S4 Submit Actual:', props['S4 Submit Actual']?.date?.start);
  }
}
