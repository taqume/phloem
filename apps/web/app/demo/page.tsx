import type { Metadata } from "next";

import { MarketingDemo } from "../../components/marketing-demo-page";

export const metadata: Metadata = {
  title: "Guided Demo | Phloem",
  description: "Test Phloem's bounded authority, private settlement and rejection boundaries in a deterministic guided simulation.",
};

export default function DemoPage() {
  return <MarketingDemo locale="en" />;
}
