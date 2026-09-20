import type { Metadata } from "next";

import { MarketingHome } from "../../components/marketing-home";

export const metadata: Metadata = {
  title: "Phloem | Otonom Ajanlar için Sınırlı Finansal Yetki",
  description: "Phloem, hazine kontrolünü devretmeden otonom ajanlara gizli, denetlenebilir ve kurallarla sınırlandırılmış finansal yetki verir.",
};

export default function TurkishHomePage() {
  return <MarketingHome locale="tr" />;
}
