import { createClient } from "@hey-api/openapi-ts";

// Get document, or throw exception on error
//file touch openapi-ts.ts
// command     "openapi-ts": "npx tsx openapi-ts.ts"

createClient({
  input: "https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml",
  output: "src/lib/pipedrive_v2/generated",
  parser: {
    transforms: {
      propertiesRequiredByDefault: true,
    },
  },
  plugins: [
    {
      asClass: true, // default
      name: "@hey-api/sdk",
    },
  ],
})
  .then(() => console.log("✅ Pipedrive v2 SDK generated successfully"))
  .catch((e) => {
    console.error("❌ Failed to generate Pipedrive v2 SDK:", e);
  });
