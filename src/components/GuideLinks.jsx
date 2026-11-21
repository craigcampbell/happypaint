const guides = [
  ['/parents', 'Parents & teachers'],
  ['/safety', 'Room safety'],
  ['/faq', 'Common questions'],
  ['/privacy', 'Privacy'],
];

export default function GuideLinks({ current, onNavigate }) {
  return <nav className="guide-links" aria-label="Drawing guides">
    {guides.map(([href, label]) => <a key={href} href={href} aria-current={href === current ? 'page' : undefined}
      onClick={event => {
        if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        onNavigate(href);
      }}>{label}</a>)}
  </nav>;
}
