import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest";
import { membershipProvision, educationProvision } from "@/lib/inngest-functions";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [membershipProvision, educationProvision],
});
