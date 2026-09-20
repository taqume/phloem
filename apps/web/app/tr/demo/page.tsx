import type { Metadata } from "next";

import { MarketingDemo } from "../../../components/marketing-demo-page";

export const metadata: Metadata = {
  title: "Yönlendirmeli Demo | Phloem",
  description: "Phloem'in sınırlı yetki, gizli ödeme ve yetkisiz işlem reddi sınırlarını deterministik bir simülasyonda deneyin.",
};

export default function TurkishDemoPage() {
  return <MarketingDemo locale="tr" />;
}
