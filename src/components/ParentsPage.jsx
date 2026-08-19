// The parents & teachers page: one honest, plain-language landing spot for the
// grown-up deciding whether Drawesome is okay for their kid or their class.
// Everything stated here reflects SHIPPED behaviour — if a claim stops being
// true in code, fix the code or fix this page in the same change.

import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";

const PILLARS = [
  {
    icon: "🛡️",
    title: "Public rooms are auto-moderated",
    body: "Chat runs through a language filter, drawings are scanned for unsafe imagery, and anything flagged alerts a host and files a report for human review. Severe language is blocked in every room on the site — public or private.",
  },
  {
    icon: "🔒",
    title: "Private rooms are invite-only — and say what they are",
    body: "A private room only exists for people who have its code. It shows a clear “not auto-moderated like public rooms” reminder, severe language is still blocked, drawings can still be flagged, and every room has one-tap reporting.",
  },
  {
    icon: "🙈",
    title: "No strangers watching",
    body: "Private rooms cannot be spectated, ever. Homepage viewers of public rooms see the artwork only — never names, chat, or who is in the room.",
  },
  {
    icon: "👤",
    title: "No accounts needed, no people search",
    body: "Kids draw as guests with fun random names. You browse rooms and art — there is no way to search for people, no follower counts, and no direct messages.",
  },
  {
    icon: "🚫",
    title: "No ads. No real-money purchases.",
    body: "There is no advertising and nothing to buy with real money. The in-app currency is play-money earned by drawing.",
  },
  {
    icon: "🧽",
    title: "Data that actually deletes",
    body: "Art is saved on the child's own device by default. Deleting an account erases saved art, wall posts, and chat history from our servers, and room chat records are automatically purged after 90 days regardless.",
  },
];

const CLASSROOM = [
  ["1", "Open drawesome.art and press Create a room — you'll get a short room code."],
  ["2", "Project your screen and let students join at drawesome.art with the code. No student accounts, no emails, no installs — it runs in the browser, including on Chromebooks and iPads."],
  ["3", "You are the room's host: you can lock the canvas while you explain, mute or remove a painter, clear the canvas, and review anything the safety system flags."],
  ["4", "Try a themed activity: the daily challenge, Draw & Guess, the animation studio, or upload a photo for everyone to trace (host-only feature)."],
];

export default function ParentsPage({ onNavigate }) {
  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/parents" />
      <main className="site-page-body parents-page">
        <header className="parents-hero">
          <p className="eyebrow">For the grown-ups</p>
          <h1>What Drawesome is — and how we keep it safe</h1>
          <p className="site-lead">
            Drawesome is a live drawing hangout where kids and teens paint, play drawing games, and
            share art together. This page is the honest tour for parents, guardians, and teachers.
          </p>
        </header>

        <section className="safety-grid" aria-label="How safety works">
          {PILLARS.map((item) => (
            <article key={item.title} className="safety-card">
              <span className="safety-icon" aria-hidden="true">{item.icon}</span>
              <h2>{item.title}</h2>
              <p>{item.body}</p>
            </article>
          ))}
        </section>

        <section className="parents-ages">
          <h2>Ages</h2>
          <p>
            Drawing never requires an account. Creating an account is for ages <strong>13 and up</strong>,
            or set up by a parent/guardian for a younger child — the sign-up form asks, and under-13s
            are pointed back to guest drawing. There is a chat-free finger-painting room for the
            littlest artists, and public rooms are moderated for everyone.
          </p>
        </section>

        <section className="parents-classroom">
          <h2>🏫 Teachers &amp; clubs: host a drawing session in two minutes</h2>
          <ol className="parents-steps">
            {CLASSROOM.map(([n, step]) => (
              <li key={n}>
                <span className="parents-step-num" aria-hidden="true">{n}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
          <p className="parents-note">
            It&rsquo;s free. If you use Drawesome with a class, we&rsquo;d genuinely love to hear how it
            went: <a href="mailto:hello@drawesome.art">hello@drawesome.art</a>
          </p>
        </section>

        <section className="parents-contact">
          <h2>Questions or concerns</h2>
          <p>
            Every room and every gallery post has a one-tap report button (⚑) that goes straight to a
            human moderator, and reporters get a receipt. For anything else:{" "}
            <a href="mailto:safety@drawesome.art">safety@drawesome.art</a>. See also our{" "}
            <a
              href="/privacy"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onNavigate("/privacy");
              }}
            >
              privacy page
            </a>{" "}
            and the{" "}
            <a
              href="/faq"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onNavigate("/faq");
              }}
            >
              safety FAQ
            </a>
            .
          </p>
        </section>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
