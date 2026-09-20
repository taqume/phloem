export type MarketingLocale = "en" | "tr";

const en = {
  localeName: "English",
  alternateLocale: "tr" as MarketingLocale,
  alternateLabel: "TR",
  alternateAria: "Türkçe sürüme geç",
  nav: { home: "Home", protocol: "Protocol", evidence: "Evidence", demo: "Try Demo" },
  footer: {
    tagline: "Private financial authority for autonomous organizations.",
    demo: "Demo",
    github: "GitHub",
    testnet: "Testnet",
    meta: "STELLAR PRO HACKATHON · 2026",
  },
  home: {
    hero: {
      kicker: "Financial authority for autonomous agents",
      title: "Give agents room to act.",
      accent: "Keep capital under control.",
      lead: "Phloem lets an organization delegate private, policy-bounded spending power without giving an AI model its treasury keys.",
      primary: "Run Guided Demo",
      secondary: "Explore the Protocol",
      proof: ["Stellar Testnet", "Real private settlement", "Open evidence"],
    },
    authority: {
      map: "Live authority map",
      active: "policy active",
      company: "Company root",
      custody: "Custody retained",
      supervisor: "Supervisor",
      research: "Research",
      builder: "Builder",
      delegateOnly: "Delegate only",
      approvedProvider: "Approved provider",
      separateScope: "Separate scope",
      privateSettlement: "PRIVATE SETTLEMENT",
      providerPaid: "Provider paid",
      publicAmount: "Public amount · 0",
      enforcement: "Soroban enforcement",
    },
    integrations: { label: "BUILT WITH", items: ["STELLAR", "SOROBAN", "CIRCLE USDC", "STELLAR PRIVATE PAYMENTS", "FREIGHTER"] },
    problem: {
      kicker: "The missing control layer",
      title: "Agents can make decisions. They still need accountable money.",
      statement: "A treasury key gives an agent too much power. Manual approval removes the speed that made the agent useful. Off-chain limits cannot stop a compromised runtime.",
      detail: "Phloem turns capital into constrained capabilities. Contracts enforce the hard limit. Models choose only within it.",
      modelTitle: "Model decides",
      modelText: "Which allowed action to propose",
      protocolTitle: "Protocol decides",
      protocolText: "Whether value may move",
    },
    protocol: {
      kicker: "Protocol anatomy",
      title: "One root delegates narrower branches with enforceable outcomes.",
      description: "TreasuryController and Agent Accounts remain the financial source of truth across every layer.",
      layers: [
        { index: "01", title: "Company root", copy: "The organization funds one root and signs the session policy. Treasury custody stays here.", meta: "require_auth" },
        { index: "02", title: "Bounded branches", copy: "Supervisor, Research and Builder receive narrower limits, actions, providers and expiries.", meta: "Budget Graph" },
        { index: "03", title: "Private commerce", copy: "A reservation-specific key binds the offer, usage, voucher and hidden payment.", meta: "SPP + Groth16" },
        { index: "04", title: "Selective proof", copy: "The company proves a fixed policy statement without publishing its procurement history.", meta: "AuditQL" },
      ],
    },
    flow: {
      kicker: "Real-world capital loop",
      title: "From local rails to agent commerce and back.",
      description: "Anchors move value across the real-world boundary. Phloem controls what autonomous systems may do between entry and exit.",
      steps: ["Local fiat", "Stellar USDC", "Root authority", "Agent branch", "Provider", "Local fiat"],
      note: "The official TR Mock Anchor remained non-terminal during the recorded run. Phloem reports that upstream condition and keeps the Testnet protocol evidence separate.",
    },
    evidence: {
      kicker: "Public Testnet evidence",
      title: "Every core transition is inspectable.",
      link: "Inspect the controller on Stellar Expert ↗",
      points: [
        { value: "1.00", unit: "USDC", label: "Private root backed on Testnet" },
        { value: "0.01", unit: "USDC", label: "Provider settlement completed" },
        { value: "3", unit: "accounts", label: "Independent agent identities" },
        { value: "0", unit: "public amount", label: "Recorded by the SPP settlement" },
      ],
      transactions: ["Private settlement", "Provider SPP exit", "Session closure"],
    },
    sdk: {
      kicker: "V1 product direction",
      title: "Bring your own agents.",
      description: "Phloem is becoming an SDK and API for agent runtimes. MCP will be one adapter over the same typed authority interface.",
      features: ["Immutable session policy", "Scoped smart-account authority", "Private payment and selective audit"],
      preview: "SDK preview",
    },
    final: { kicker: "See the control loop", title: "Delegate authority.", accent: "Test its boundary.", action: "Open the Demo" },
  },
  demo: {
    hero: {
      kicker: "Interactive protocol walkthrough",
      title: "See what the agent can do",
      accent: "and where it stops.",
      description: "Run the P0 authority path in a deterministic simulation. No wallet, API key or asset movement is required.",
      noticeTitle: "GUIDED SIMULATION",
      notice: "Canonical policy and Testnet-backed evidence. Browser-local state only.",
    },
    lab: {
      kicker: "P0 policy lab",
      title: "Run the authority path",
      steps: [
        { label: "SESSION", title: "Create a private root", description: "Company policy fixes USDC, PRIVATE settlement, approved service, expiry and delegation depth.", action: "Create PRIVATE session", event: "SESSION_CREATED · company require_auth accepted" },
        { label: "DELEGATION", title: "Narrow the authority", description: "Supervisor receives 0.70 USDC. Research receives 0.60 USDC and one approved provider. Builder stays isolated.", action: "Delegate bounded authority", event: "BUDGET_SPLIT · conservation proof verified" },
        { label: "COMMERCE", title: "Bind the service evidence", description: "Research accepts a signed 0.01 USDC offer and binds the HTTP result to UsageEvidence and a reservation-specific voucher.", action: "Request research service", event: "USAGE_BOUND · offer + response + voucher committed" },
        { label: "SETTLEMENT", title: "Settle and account atomically", description: "SPP pays the provider, creates the refund and advances the hidden audit total in one Soroban call tree.", action: "Settle 0.01 USDC privately", event: "SETTLED · public_amount 0 · audit updated" },
      ],
      completeAria: "primary steps complete",
      custodyLabel: "Company custody",
      custodyValue: "Retained",
      settlementLabel: "Settlement",
      providerLabel: "Approved provider",
      providerValue: "Research Data",
      backingLabel: "Root backing",
      pending: "Pending",
      nextAction: "NEXT TYPED ACTION",
      finalState: "FINAL PROTOCOL STATE",
      closedLoop: "Closed-loop authority",
      events: "PROTOCOL EVENTS",
      waiting: "Waiting for company authorization…",
      rejectionEvent: "REJECTED · Builder cannot read Research budget",
      rejectionAction: "Test cross-branch rejection",
      rejected: "Unauthorized action rejected",
      reset: "Reset Demo",
      guarantees: [
        { title: "Model output is a proposal.", text: "Typed schemas and live context checks run before transaction construction." },
        { title: "Authority lives on Stellar.", text: "Agent Account rules and TreasuryController state enforce the branch boundary." },
        { title: "Payment and accounting stay atomic.", text: "A failed nested call rolls back the complete private transition." },
      ],
    },
    evidence: {
      kicker: "Simulation versus evidence",
      title: "A browser simulation backed by a recorded protocol run.",
      description: "The demo uses deterministic browser state so reviewers can test the policy without credentials. These links point to the matching live Testnet operations.",
      cards: [
        { label: "01 · ROOT BACKING", title: "PRIVATE activation" },
        { label: "02 · SETTLEMENT", title: "Atomic SPP payment" },
        { label: "03 · PROVIDER EXIT", title: "Public USDC recovered" },
      ],
    },
  },
} as const;

type WidenStrings<T> = T extends string
  ? string
  : T extends readonly unknown[]
    ? { readonly [K in keyof T]: WidenStrings<T[K]> }
    : T extends object
      ? { readonly [K in keyof T]: WidenStrings<T[K]> }
      : T;

export type MarketingMessages = Omit<WidenStrings<typeof en>, "alternateLocale"> & {
  readonly alternateLocale: MarketingLocale;
};

const tr: MarketingMessages = {
  localeName: "Türkçe",
  alternateLocale: "en",
  alternateLabel: "EN",
  alternateAria: "Switch to English",
  nav: { home: "Ana Sayfa", protocol: "Protokol", evidence: "Kanıtlar", demo: "Demoyu Aç" },
  footer: {
    tagline: "Otonom organizasyonlar için gizli finansal yetki katmanı.",
    demo: "Demo",
    github: "GitHub",
    testnet: "Testnet",
    meta: "STELLAR PRO HACKATHON · 2026",
  },
  home: {
    hero: {
      kicker: "Otonom ajanlar için finansal yetki",
      title: "Ajanlara hareket alanı verin.",
      accent: "Sermayenin kontrolünü koruyun.",
      lead: "Phloem, hazine anahtarlarını bir yapay zekâ modeline teslim etmeden gizli ve kurallarla sınırlandırılmış harcama yetkisi devretmenizi sağlar.",
      primary: "Yönlendirmeli Demoyu Başlat",
      secondary: "Protokolü İncele",
      proof: ["Stellar Testnet", "Gerçek gizli ödeme", "Açık işlem kanıtları"],
    },
    authority: {
      map: "Canlı yetki haritası",
      active: "politika etkin",
      company: "Şirket kökü",
      custody: "Varlık kontrolü şirkette",
      supervisor: "Yönetici",
      research: "Araştırma",
      builder: "Geliştirici",
      delegateOnly: "Yalnız yetki devri",
      approvedProvider: "Onaylı sağlayıcı",
      separateScope: "Ayrı yetki alanı",
      privateSettlement: "GİZLİ ÖDEME",
      providerPaid: "Sağlayıcı ödendi",
      publicAmount: "Açık tutar · 0",
      enforcement: "Soroban denetimi",
    },
    integrations: { label: "ALTYAPI", items: ["STELLAR", "SOROBAN", "CIRCLE USDC", "STELLAR PRIVATE PAYMENTS", "FREIGHTER"] },
    problem: {
      kicker: "Eksik kontrol katmanı",
      title: "Ajanlar karar verebilir. Paranın denetlenebilir kalması gerekir.",
      statement: "Hazine anahtarı, ajana gereğinden fazla güç verir. Her işlem için insan onayı ise otonominin hızını ortadan kaldırır. Zincir dışı limitler ele geçirilmiş bir çalışma ortamını durduramaz.",
      detail: "Phloem sermayeyi sınırlandırılmış yetkilere dönüştürür. Kesin sınırı sözleşmeler uygular. Modeller yalnız izin verilen alan içinde seçim yapar.",
      modelTitle: "Modelin kararı",
      modelText: "İzin verilen hangi işlemi önereceği",
      protocolTitle: "Protokolün kararı",
      protocolText: "Değerin hareket edip edemeyeceği",
    },
    protocol: {
      kicker: "Protokol yapısı",
      title: "Tek kök, uygulanabilir kurallarla daha dar yetki dalları oluşturur.",
      description: "Her katmanda finansal doğruluğun kaynağı TreasuryController ve Agent Account sözleşmeleridir.",
      layers: [
        { index: "01", title: "Şirket kökü", copy: "Şirket tek kökü fonlar ve oturum politikasını imzalar. Hazine kontrolü bu katmanda kalır.", meta: "require_auth" },
        { index: "02", title: "Sınırlı dallar", copy: "Yönetici, Araştırma ve Geliştirici ajanları daha dar limitler, işlemler, sağlayıcılar ve süreler alır.", meta: "Budget Graph" },
        { index: "03", title: "Gizli ticaret", copy: "Rezervasyona özel anahtar; teklifi, kullanımı, kuponu ve gizli ödemeyi birbirine bağlar.", meta: "SPP + Groth16" },
        { index: "04", title: "Seçici kanıt", copy: "Şirket, satın alma geçmişini yayımlamadan sabit bir politika koşulunu kanıtlar.", meta: "AuditQL" },
      ],
    },
    flow: {
      kicker: "Gerçek dünya sermaye döngüsü",
      title: "Yerel ödeme raylarından ajan ticaretine ve tekrar yerel paraya.",
      description: "Anchor, değeri gerçek dünya sınırından geçirir. Phloem giriş ile çıkış arasında otonom sistemlerin finansal yetkisini denetler.",
      steps: ["Yerel para", "Stellar USDC", "Kök yetki", "Ajan dalı", "Sağlayıcı", "Yerel para"],
      note: "Resmî TR Mock Anchor, kaydedilen akışta terminal SEP-6 durumuna ulaşmadı. Phloem bu dış servis durumunu açıkça raporlar ve Testnet protokol kanıtlarından ayrı tutar.",
    },
    evidence: {
      kicker: "Açık Testnet kanıtları",
      title: "Temel geçişlerin tümü zincir üzerinde incelenebilir.",
      link: "Controller sözleşmesini Stellar Expert üzerinde aç ↗",
      points: [
        { value: "1.00", unit: "USDC", label: "Testnet üzerinde fonlanan gizli kök" },
        { value: "0.01", unit: "USDC", label: "Tamamlanan sağlayıcı ödemesi" },
        { value: "3", unit: "hesap", label: "Bağımsız ajan kimliği" },
        { value: "0", unit: "açık tutar", label: "SPP ödeme kaydındaki değer" },
      ],
      transactions: ["Gizli ödeme", "Sağlayıcı SPP çıkışı", "Oturum kapanışı"],
    },
    sdk: {
      kicker: "V1 ürün yönü",
      title: "Kendi ajanlarınızı getirin.",
      description: "Phloem, ajan çalışma ortamları için bir SDK ve API katmanına dönüşüyor. MCP, aynı tip güvenli yetki arayüzünün adaptörlerinden biri olacak.",
      features: ["Değiştirilemez oturum politikası", "Kapsamı sınırlandırılmış akıllı hesap yetkisi", "Gizli ödeme ve seçici denetim"],
      preview: "SDK önizlemesi",
    },
    final: { kicker: "Kontrol döngüsünü deneyin", title: "Yetkiyi devredin.", accent: "Sınırı test edin.", action: "Demoyu Aç" },
  },
  demo: {
    hero: {
      kicker: "Etkileşimli protokol anlatımı",
      title: "Ajanın yapabileceklerini",
      accent: "ve durduğu sınırı görün.",
      description: "P0 yetki akışını deterministik simülasyonda çalıştırın. Cüzdan, API anahtarı veya varlık hareketi gerekmez.",
      noticeTitle: "YÖNLENDİRMELİ SİMÜLASYON",
      notice: "Kanonik politika ve Testnet işlem kanıtları. Durum yalnız tarayıcıda tutulur.",
    },
    lab: {
      kicker: "P0 politika laboratuvarı",
      title: "Yetki akışını çalıştırın",
      steps: [
        { label: "OTURUM", title: "Gizli kökü oluşturun", description: "Şirket politikası USDC varlığını, PRIVATE ödemeyi, onaylı servisi, süreyi ve devir derinliğini sabitler.", action: "PRIVATE oturumu oluştur", event: "SESSION_CREATED · şirket require_auth yetkisi kabul edildi" },
        { label: "YETKİ DEVRİ", title: "Yetkiyi daraltın", description: "Yönetici 0.70 USDC, Araştırma 0.60 USDC ve tek onaylı sağlayıcı yetkisi alır. Geliştirici dalı ayrı kalır.", action: "Sınırlı yetkiyi devret", event: "BUDGET_SPLIT · korunum kanıtı doğrulandı" },
        { label: "TİCARET", title: "Servis kanıtını bağlayın", description: "Araştırma ajanı imzalı 0.01 USDC teklifi kabul eder; HTTP sonucunu UsageEvidence ve rezervasyona özel kupona bağlar.", action: "Araştırma servisini çağır", event: "USAGE_BOUND · teklif, yanıt ve kupon bağlandı" },
        { label: "ÖDEME", title: "Ödeme ve kaydı atomik tamamlayın", description: "SPP sağlayıcıyı öder, iadeyi oluşturur ve gizli denetim toplamını tek Soroban çağrı ağacında ilerletir.", action: "0.01 USDC gizli ödemeyi tamamla", event: "SETTLED · public_amount 0 · denetim güncellendi" },
      ],
      completeAria: "ana adım tamamlandı",
      custodyLabel: "Şirket kontrolü",
      custodyValue: "Korunuyor",
      settlementLabel: "Ödeme türü",
      providerLabel: "Onaylı sağlayıcı",
      providerValue: "Araştırma Verisi",
      backingLabel: "Kök fonu",
      pending: "Bekliyor",
      nextAction: "SONRAKİ TİP GÜVENLİ İŞLEM",
      finalState: "SON PROTOKOL DURUMU",
      closedLoop: "Kapalı döngü yetki",
      events: "PROTOKOL OLAYLARI",
      waiting: "Şirket yetkisi bekleniyor…",
      rejectionEvent: "REJECTED · Geliştirici, Araştırma bütçesini okuyamaz",
      rejectionAction: "Dallar arası yetki ihlalini dene",
      rejected: "Yetkisiz işlem reddedildi",
      reset: "Demoyu Sıfırla",
      guarantees: [
        { title: "Model çıktısı yalnız bir öneridir.", text: "Tip güvenli şemalar ve canlı bağlam kontrolleri işlem kurulmadan önce çalışır." },
        { title: "Yetki Stellar üzerinde yaşar.", text: "Agent Account kuralları ve TreasuryController durumu her dalın sınırını uygular." },
        { title: "Ödeme ve muhasebe atomik kalır.", text: "İç çağrılardan biri başarısız olursa gizli geçişin tamamı geri alınır." },
      ],
    },
    evidence: {
      kicker: "Simülasyon ve gerçek kanıt",
      title: "Tarayıcı simülasyonu, kaydedilmiş protokol akışıyla desteklenir.",
      description: "Demo, inceleyenlerin kimlik bilgisi kullanmadan politikayı sınaması için deterministik tarayıcı durumu kullanır. Bağlantılar karşılık gelen gerçek Testnet işlemlerini açar.",
      cards: [
        { label: "01 · KÖK FONU", title: "PRIVATE aktivasyon" },
        { label: "02 · ÖDEME", title: "Atomik SPP ödemesi" },
        { label: "03 · SAĞLAYICI ÇIKIŞI", title: "Açık USDC tahsilatı" },
      ],
    },
  },
};

export const marketingMessages: Readonly<Record<MarketingLocale, MarketingMessages>> = { en, tr };

export function localePath(locale: MarketingLocale, path: "/" | "/demo"): string {
  if (locale === "en") return path;
  return path === "/" ? "/tr" : `/tr${path}`;
}
