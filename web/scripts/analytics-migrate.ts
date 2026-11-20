import { analyticsIndex } from "../lib/analytics";
const index = analyticsIndex();
if (!index) throw Error("Choose postgres or clickhouse with ANALYTICS_BACKEND first");
try {
  await index.migrate();
  console.log("Analytics schema is ready.");
} finally {
  await index.close();
}
