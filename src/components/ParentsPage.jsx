// The parents & teachers page: one honest, plain-language landing spot for the
// grown-up deciding whether Drawesome is okay for their kid or their class.
// Everything stated here reflects SHIPPED behaviour — if a claim stops being
// true in code, fix the code or fix this page in the same change.

import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { createInviteCode } from "../utils/social";

const PILLARS = [
  {
    icon: "🛡️",
    title: "Filters help; adult supervision still matters",
    body: "Public chat is filtered. Image scanning runs when a capable participant's device is available, so it is not guaranteed in every session. Filters can miss things. Hosts have moderation tools, and anyone can report a concern. Severe language is filtered in private rooms too.",
  },
  {
    icon: "🔒",
    title: "Room codes are invitations",
    body: "A private room is not listed in public room discovery. Anyone with its link or code can join, including someone who receives a forwarded invitation. Share it only with people you know, and stay in the room with younger artists.",
  },
  {
    icon: "🙈",
    title: "Know what is public",
    body: "Public-room artwork, chat, and display names can appear in homepage previews. Private rooms do not allow the public spectator connection. Use a nickname and keep real names, school names, contact details, and personal photos out of shared art and chat.",
  },
  {
    icon: "👤",
    title: "No accounts needed, no people search",
    body: "Kids draw as guests with fun random names. You browse rooms and art — there is no way to search for people, no follower counts, and no direct messages.",
  },
  {
    icon: "🚫",
    title: "Free drawing, optional adult-owned Family plan",
    body: "Drawing and joining a room do not require a payment or account. Drops are play money, with no paid coins or cash tips. Free spaces may display contextual ads. Where subscriptions are available, an adult can choose an ad-free Family space for invited guests.",
  },
  {
    icon: "🧽",
    title: "Understand what gets saved",
    body: "Drawings and settings can be saved on the device; shared rooms and published wall posts also use server storage. Optional accounts add gallery sync. The Privacy page explains storage, retention, and deletion choices. Download art you want to keep before clearing browser data.",
  },
];

const CLASSROOM = [
  ["1", "Create a fresh room below. Try one brush stroke and check that the drawing tools work on the devices you plan to use."],
  ["2", "Choose Invite friends inside the studio and share the link or code with your group. Students can join as guests in a browser, with no email address or install."],
  ["3", "Check the Host controls before inviting your group: you can lock the canvas, mute or remove a painter, and clear the canvas. The first guest in an unowned private room is its temporary host; guest hosting can pass to another painter when you leave."],
  ["4", "Set a short timer, choose one activity below, and agree to add to one another's art kindly. At the end, use the studio's download/export tools to keep a copy. Posting to the public Wall is optional."],
];

const ACTIVITIES = [
  {
    title: "Build a creature together",
    time: "10 minutes · pairs or small groups",
    steps: "One artist draws a body. A partner adds feet, then you take turns adding a face, a habitat, and something surprising. Give your creature a made-up name.",
    reflection: "Talk about it: how did your partner's ideas change your drawing?",
  },
  {
    title: "Color scavenger hunt",
    time: "10 minutes · families or clubs",
    steps: "Choose three colors. Each person draws something imaginary or everyday using only those colors, in a different corner of the shared canvas. Add a path connecting your drawings.",
    reflection: "Talk about it: where did you use the same color in different ways?",
  },
  {
    title: "Tell a three-part story",
    time: "15 minutes · reading or writing warm-up",
    steps: "Draw three boxes across the canvas: a beginning, a problem, and an ending. Take turns filling the boxes with pictures, then retell the story together. Use invented characters and places.",
    reflection: "Talk about it: what detail makes the ending connect to the beginning?",
  },
];

export default function ParentsPage({ onNavigate }) {
  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/parents" />
      <main className="site-page-body parents-page">
        <header className="parents-hero">
          <p className="eyebrow">For the grown-ups</p>
          <h1>Free drawing activities for families &amp; classrooms</h1>
          <p className="site-lead">
            Make one drawing together in your browser. Start with a short, adult-led session,
            invite people you know, and try one of the activities below. No student accounts needed.
          </p>
          <div className="site-page-actions">
            <button type="button" className="primary-action" onClick={() => onNavigate(`/join/${createInviteCode()}`)}>Create an activity room →</button>
            <a href="#activities">See the activities</a>
          </div>
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
            are pointed back to guest drawing. For a family or class, begin in a private room with an
            adult present. Read the privacy and safety information before using it with students.
          </p>
        </section>

        <section className="parents-classroom">
          <h2>Set up your first group drawing session</h2>
          <ol className="parents-steps">
            {CLASSROOM.map(([n, step]) => (
              <li key={n}>
                <span className="parents-step-num" aria-hidden="true">{n}</span>
                <p>{step}</p>
              </li>
            ))}
          </ol>
          <p className="parents-note">
            Room sizes are limited. Start with a small group; for larger classes, try separate rooms for each group.
          </p>
        </section>

        <section className="parents-activities" id="activities" aria-labelledby="parents-activities-title">
          <h2 id="parents-activities-title">Three activities you can try today</h2>
          <p>No worksheet, account, or paid plan needed. Use the shared canvas and the brushes already in the studio.</p>
          <div className="parents-activity-grid">
            {ACTIVITIES.map((activity) => (
              <article className="parents-activity-card" key={activity.title}>
                <p className="parents-activity-time">{activity.time}</p>
                <h3>{activity.title}</h3>
                <p>{activity.steps}</p>
                <p><strong>{activity.reflection}</strong></p>
              </article>
            ))}
          </div>
          <div className="site-page-actions">
            <button type="button" className="primary-action" onClick={() => onNavigate(`/join/${createInviteCode()}`)}>Try an activity together →</button>
          </div>
          <p className="parents-note">Help shape the next activity: tell us what worked and what got in the way at <a href="mailto:hello@drawesome.art">hello@drawesome.art</a>. Please leave out student names and personal details.</p>
        </section>

        <section className="parents-contact">
          <h2>Questions or concerns</h2>
          <p>
            Use the report control in a room or on a gallery post to send a concern for review.
            Reports are not a promise of an immediate response. For anything else:{" "}
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
