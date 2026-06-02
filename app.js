"use strict";
require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { Client } = require("@notionhq/client");

const app    = express();
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── Drawing Flow routes (MUST be before static middleware) ───────────────────
const mountDrawingFlow = require("./drawing-flow");
mountDrawingFlow(app, notion);

// ─── /api/projects ────────────────────────────────────────────────────────────
app.get("/api/projects", async (req, res) => {
  try {
    const PROJECTS_DB = process.env.NOTION_DB_PROJECTS;
    const results = [];
    let cursor;
    do {
      const r = await notion.databases.query({
        database_id: PROJECTS_DB,
        sorts: [{ property: "Name", direction: "ascending" }],
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      results.push(...r.results);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    const projects = results.map((p) => ({
      id:   p.id,
      name: p.properties?.Name?.title?.[0]?.plain_text ?? "(Unnamed)",
    }));
    res.json({ projects });
  } catch (err) {
    console.error("GET /api/projects", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/tasks ───────────────────────────────────────────────────────────────
// ?projectId= to scope to a project (optional but recommended)
app.get("/api/tasks", async (req, res) => {
  try {
    const { projectId } = req.query;
    const TASKS_DB = process.env.NOTION_DB_TASKS;

    const filter = projectId
      ? { property: "Projects", relation: { contains: projectId } }
      : undefined;

    const results = [];
    let cursor;
    do {
      const r = await notion.databases.query({
        database_id: TASKS_DB,
        ...(filter ? { filter } : {}),
        sorts: [{ property: "Item No.", direction: "ascending" }],
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      results.push(...r.results);
      cursor = r.has_more ? r.next_cursor : undefined;
    } while (cursor);

    const tasks = results.map((p) => ({
      id:     p.id,
      name:   p.properties?.["Item Name"]?.title?.[0]?.plain_text ?? "(Unnamed)",
      itemNo: p.properties?.["Item No."]?.number ?? null,
    }));
    res.json({ tasks });
  } catch (err) {
    console.error("GET /api/tasks", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── SPA catch-all ────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = app;
