// Pages live at paths under the site's folder, such as gt3/105. The share worker
// serves each with a <base> naming that folder, so files load from the folder;
// opened as the folder's own index.html, the page names it here. Imported first,
// before any module works out where the site's files are.
if (!document.querySelector("base"))
  document.head.prepend(Object.assign(document.createElement("base"), { href: location.pathname.replace(/[^/]*$/, "") }));
