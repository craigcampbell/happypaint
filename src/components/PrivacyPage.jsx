// Keep these descriptions aligned with server storage and accountDeletion.js.
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";

export default function PrivacyPage({ onNavigate }) {
  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/privacy" />
      <main className="site-page-body">
        <h1>Privacy</h1>
        <p className="site-lead">
          You can draw and paint together without an account. This page explains what stays in your
          browser, what reaches our servers, and what other people can see.
        </p>

        <h2>What we store</h2>
        <ul>
          <li><strong>Guest drawing.</strong> You do not need to provide an email or real name. Rooms assign a session identifier and nickname. A separate random identifier saved in your browser connects guest server saves to this device.</li>
          <li><strong>Art and browser storage.</strong> Drafts, gallery items, brushes and preferences use browser storage. Saved art can also be stored on our server under your device identifier or account. Shared canvas history is stored so later visitors can see the drawing.</li>
          <li><strong>Optional accounts.</strong> Signing in stores account details such as your email, name and account identifier, and connects features such as gallery sync, room ownership and optional Family billing.</li>
          <li><strong>Chat and reports.</strong> Room chat history is stored with nicknames and messages; moderation logs also include an account identifier when signed in. Reports may keep the reported reason, reporter nickname and recent chat, including shared doodle images, for moderator review.</li>
          <li><strong>Usage statistics.</strong> We keep totals and records of drawing sessions: rooms visited, session times, drawing and chat counts, brushes and saves. These can include a guest nickname or account identifier, country when available, language, time zone, device type, input type and approximate screen size. Administrators use these records to understand use and performance. Network addresses are also used for connection security and abuse limits; raw network addresses are not saved in these usage statistics.</li>
          <li><strong>Family billing, when available.</strong> Stripe handles checkout and card details. Drawesome keeps billing identifiers, subscription status, payment period information and the time and version of the adult purchase confirmation. If cancellation needs to be retried, the necessary identifiers remain until it succeeds. A one-way account marker is retained temporarily to prevent old payment events from restoring a deleted account&apos;s billing link.</li>
          <li><strong>Advertising, when enabled.</strong> Free spaces may request ads from Google Ad Manager. These requests are marked as child-directed, under-age-of-consent and non-personalized, with restricted data processing. The ad script is not loaded when ad placements are unconfigured.</li>
        </ul>

        <h2>What other people can see</h2>
        <p>
          Public-room previews can show artwork, nicknames and chat. Art you post on the Fridge Wall
          is public. Private rooms are excluded from public previews, but people with the room link
          or code can attempt to join. Share invitations only with people you intend to invite, and
          avoid putting personal information in drawings, nicknames or chat.
        </p>
        <p>
          Public rooms use automated moderation, and moderators can review reports and chat logs.
          Filters can miss harmful content. Private rooms do not have the same automated drawing
          moderation as public rooms.
        </p>

        <h2>How records are kept</h2>
        <p>
          Leaving a room does not erase its canvas or chat. Chat buffers, moderation logs and usage
          records have storage limits. Some inactive chat logs are removed automatically, but this
          is not a fixed deletion deadline for every message. Active-room history, report copies
          and usage statistics can remain after a session ends.
        </p>

        <h2>Our approach</h2>
        <ul>
          <li>No behavioral ad targeting and no selling personal data.</li>
          <li>No paid coins, cash tips, or child-facing purchases. Family is an optional adult-owned subscription.</li>
          <li>No public people-search — you find <em>rooms</em>, not individual kids.</li>
        </ul>

        <h2>Deleting data</h2>
        <p>
          The Account panel&apos;s deletion control is free. Without a signed-in account, it runs
          local cleanup for drafts, gallery items and other app stores in this browser. It does
          not delete guest saves from the server or erase content already shared with a room.
          Some browser identifiers and preferences may remain; your browser&apos;s site-data
          controls can clear those too.
        </p>
        <p>
          When signed in, the same control also requests cloud account deletion and cleanup of
          account-owned server saves and wall posts, identifiable account-linked chat, and account
          links in usage records. It cancels an attached Family subscription or queues a retry.
          If cloud deletion cannot complete, the Account panel asks you to sign in and retry.
        </p>
        <p>
          This is not a complete erase of everything you have shared. Shared canvas strokes,
          some older chat and moderation-report copies, and usage totals can remain. A local
          deletion receipt does not schedule a later server purge. Files other people have
          downloaded are outside this deletion process.
        </p>

        <h2>Questions and reports</h2>
        <ul>
          <li>Use a room or gallery post&apos;s report control to flag inappropriate content.</li>
          <li>For questions about privacy or stored shared content, contact <a href="mailto:safety@drawesome.art">safety@drawesome.art</a>. Do not send payment details or other sensitive information in room chat.</li>
        </ul>

        <div className="site-page-actions">
          <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>🎨 Start painting</button>
          <button type="button" onClick={() => onNavigate("/about")}>About Drawesome</button>
        </div>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
