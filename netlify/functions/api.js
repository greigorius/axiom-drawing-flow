"use strict";
const serverless        = require("serverless-http");
const { connectLambda } = require("@netlify/blobs");
const app               = require("../../app");

const handler = serverless(app);

// This is a Lambda-compatibility function (exports.handler), so Netlify Blobs has to be
// connected to the request before getStore() will work. Without this every blob read/write
// throws MissingBlobsEnvironmentError — which drawing-flow.js swallows, so the cockpit's
// ingest feed (cockpit-notifications) silently stayed empty.
module.exports.handler = async (event, context) => {
  try { connectLambda(event); }
  catch (err) { console.warn("[blobs] connectLambda failed:", err.message); }
  return handler(event, context);
};
