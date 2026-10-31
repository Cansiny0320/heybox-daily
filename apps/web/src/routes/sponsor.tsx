import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { publicPageHead } from "../lib/seo";
import { sponsorsSchema, type SponsorEntry } from "../lib/sponsors";

export const Route = createFileRoute("/sponsor")({
  head: () =>
    publicPageHead(
      "/sponsor",
      "赞助 · Heybox Daily",
      "通过微信或支付宝支持 Heybox Daily 开源小黑盒自动签到项目。",
    ),
  component: Sponsor,
});
function Sponsor() {
  const [sponsors, setSponsors] = useState<SponsorEntry[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/sponsors", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const parsed = sponsorsSchema.safeParse(await response.json());
        if (parsed.success && !controller.signal.aborted) setSponsors(parsed.data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return (
    <section className="mx-auto max-w-6xl px-6 pt-14 pb-16 sm:px-8 sm:pt-16">
      <h1 className="text-3xl font-semibold tracking-tight">赞助</h1>
      <p className="mt-4 text-base text-muted-foreground">觉得好用的话，欢迎支持一下。</p>
      <a href="/sponsorship.png" target="_blank" rel="noreferrer" className="mt-10 block">
        <img
          src="/sponsors/sponsorship-20261101.webp"
          width={1536}
          height={1024}
          alt="微信和支付宝赞助收款码"
          className="w-full rounded-lg"
        />
      </a>
      <a
        href="/sponsorship.png"
        target="_blank"
        rel="noreferrer"
        className="mt-5 inline-flex items-center gap-1 text-base text-muted-foreground hover:text-foreground"
      >
        查看原图
        <ArrowUpRight className="size-3.5" />
      </a>
      {sponsors.length > 0 && (
        <section aria-labelledby="sponsors-heading" className="mt-12 border-t pt-8">
          <h2 id="sponsors-heading" className="text-xl font-semibold tracking-tight">
            感谢赞助
          </h2>
          <ul className="mt-6 flex flex-wrap gap-x-8 gap-y-5">
            {sponsors.map((sponsor) => (
              <li key={sponsor.id} className="flex items-center gap-3">
                <img
                  src={sponsor.avatar}
                  alt=""
                  width={48}
                  height={48}
                  loading="lazy"
                  className="size-12 rounded-full object-cover"
                />
                <span className="text-base font-medium">{sponsor.name}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
