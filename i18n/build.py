"""Website translations (Oct 2026).

The English pages stay the only pages anyone edits. This script:
  * writes /de/... and /fa/... copies of every page in PAGES, with the text
    swapped from i18n/<lang>.json, links pointing inside the same language,
    lang/dir set (Persian is right-to-left), canonical + og:url for the copy;
  * adds hreflang links and the EN · DE · فا switch to ALL versions, the
    English pages included (between <!-- i18n --> markers, replaced each run).

Usage (needs Python 3 + beautifulsoup4):
  python i18n/build.py extract   -> i18n/source.json: every text the pages show
  python i18n/build.py build     -> writes de/ and fa/, updates English pages,
                                    lists texts still missing a translation

How texts are matched: a "unit" is an element whose content has no block
elements inside (a paragraph, heading, list item, link, button…); its inner
HTML (whitespace collapsed) is the key, so inline tags like <span class=grad>
stay part of the sentence and translations can move them. Attributes (alt,
placeholder, aria-label, title, meta descriptions) and string literals in
inline <script>s use the same lookup ("js" section for scripts).
A missing translation falls back to English, and is listed.
"""
import json, os, posixpath, re, sys
from bs4 import BeautifulSoup, NavigableString, Tag, Comment, Doctype, Declaration

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://www.mysmatch.com'
LANGS = {
    # html lang, dir, locale for dates in scripts, label in the switch
    'de': {'lang': 'de', 'dir': 'ltr', 'locale': 'de-DE', 'label': 'DE'},
    'fa': {'lang': 'fa', 'dir': 'rtl', 'locale': 'fa-IR-u-ca-gregory', 'label': 'فا'},
}
# Public, indexed pages that get translated copies. The URL path of each is
# the folder (index.html) or the file without .html.
PAGES = [
    'index.html', 'events/index.html', 'events/event.html', 'jobs/index.html', 'jobs/job.html',
    'organizations/index.html', 'team/index.html', 'support/index.html',
    'delete-account/index.html', 'privacy-policy/index.html', 'terms/index.html',
]
BLOCK = {'div', 'p', 'section', 'article', 'header', 'footer', 'nav', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4',
         'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'form', 'main', 'aside', 'figure', 'blockquote',
         'details', 'summary', 'dl', 'dt', 'dd', 'select', 'textarea', 'video', 'picture'}
OPAQUE = {'svg', 'img', 'script', 'style', 'noscript', 'video', 'picture', 'iframe', 'input'}
ATTRS = ('alt', 'placeholder', 'aria-label', 'title')
META = {('name', 'description'), ('name', 'twitter:title'), ('name', 'twitter:description'),
        ('property', 'og:title'), ('property', 'og:description')}
MARK_HEAD = ('<!-- i18n:head -->', '<!-- /i18n:head -->')
MARK_SWITCH = ('<!-- i18n:switch -->', '<!-- /i18n:switch -->')
def js_strings(code):
    """(start, end, quote, content) of every string literal, skipping comments."""
    i, n, out = 0, len(code), []
    while i < n:
        c = code[i]
        if code.startswith('//', i):
            j = code.find('\n', i)
            i = n if j < 0 else j
            continue
        if code.startswith('/*', i):
            j = code.find('*/', i + 2)
            i = n if j < 0 else j + 2
            continue
        if c in '\'"`':
            j = i + 1
            while j < n and code[j] != c:
                if code[j] == '\\':
                    j += 1
                elif c != '`' and code[j] == '\n':
                    break
                j += 1
            out.append((i, j + 1, c, code[i + 1:j]))
            i = j + 1
            continue
        i += 1
    return out


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


def has_text(s):
    return bool(re.search(r'[A-Za-z]', s))


def page_url(path):
    if path == 'index.html':
        return '/'
    if path.endswith('/index.html'):
        return '/' + path[:-len('index.html')]
    return '/' + path[:-len('.html')]


# Both the clean URL and the .html file name link to a translated page.
TRANSLATED_URLS = {page_url(p).rstrip('/') or '/' for p in PAGES} | {'/' + p for p in PAGES if not p.endswith('index.html')}


def strip_injected(html):
    for a, b in (MARK_HEAD, MARK_SWITCH):
        html = re.sub(re.escape(a) + r'.*?' + re.escape(b) + r'\n?', '', html, flags=re.S)
    return html


def is_unit(tag):
    if not has_text(tag.get_text()):
        return False
    # A container with no text of its own (e.g. <nav> of links, a card of
    # <b>+<span>) is split into its children instead of becoming one unit.
    inline = tag.name in ('a', 'button', 'label', 'span', 'strong', 'em', 'b', 'small', 'title', 'option')
    if not inline and not any(isinstance(c, NavigableString) and not isinstance(c, Comment) and has_text(c) for c in tag.children):
        return False
    for d in tag.descendants:
        if isinstance(d, Tag) and (d.name in BLOCK or d.name in OPAQUE):
            return False
    return True


class Pass:
    """Walks one page; in collect mode records keys, otherwise replaces them."""

    def __init__(self, table=None, lang=None):
        self.table = table  # None = collect
        self.lang = lang
        self.found, self.missing = [], []

    def text(self, key):
        if self.table is None:
            self.found.append(('text', key)); return None
        if key in self.table.get('text', {}):
            return self.table['text'][key]
        self.missing.append(('text', key)); return None

    def walk(self, node):
        for child in list(node.children):
            if isinstance(child, (Comment, Doctype, Declaration)):
                continue
            if isinstance(child, NavigableString):
                if has_text(child) and node.name not in OPAQUE:
                    t = self.text(norm(str(child)))
                    if t is not None:
                        lead = re.match(r'^\s*', str(child)).group(0)
                        tail = re.search(r'\s*$', str(child)).group(0)
                        child.replace_with(lead + t + tail)
                continue
            if child.name in OPAQUE and child.name != 'script':
                self.attrs(child)
                continue
            if child.name == 'script':
                self.script(child)
                continue
            self.attrs(child)
            if child.name in BLOCK or child.name in ('a', 'button', 'label', 'span', 'strong', 'em', 'b', 'small', 'title', 'option'):
                if is_unit(child):
                    key = norm(child.decode_contents())
                    t = self.text(key)
                    if t is not None:
                        child.clear()
                        child.append(BeautifulSoup(t, 'html.parser'))
                    continue
            self.walk(child)

    def attrs(self, tag):
        for a in ATTRS:
            v = tag.get(a)
            if isinstance(v, str) and has_text(v):
                t = self.text(norm(v))
                if t is not None:
                    tag[a] = t

    def script(self, tag):
        if tag.get('src') or tag.get('type') == 'application/ld+json':
            return
        code = tag.string or ''
        if self.table is None:
            for _, _, _, v in js_strings(code):
                if has_text(v) and (re.match(r'^[A-Z][a-z]', v) or re.search(r'[a-z] [a-z]', v)) \
                        and not re.match(r'^(https?:|/|#|\.|rgba)', v):
                    self.found.append(('js', v))
            return
        # "jsraw": exact code snippets, for texts whose English word is also a
        # data value (e.g. { key: 'Sports', label: 'Sports' }) or that the
        # literal scanner can't see (' events').
        for old, new in self.table.get('jsraw', {}).items():
            code = code.replace(old, new)
        js = self.table.get('js', {})
        parts, last = [], 0
        for a, b, q, v in js_strings(code):
            new = js.get(v, v)
            # Links the script builds ('/events/event.html?id=', href="/jobs")
            # stay inside the same language.
            new = re.sub(r"""href=(\\?["'])(/[^"'\\]*)""", lambda m: 'href=' + m.group(1) + localize_href(m.group(2), self.lang), new)
            if re.match(r'^/[A-Za-z]', new):
                new = localize_href(new, self.lang)
            if new != v:
                parts.append(code[last:a] + q + new + q); last = b
        tag.string = ''.join(parts) + code[last:]

    def meta(self, soup):
        for m in soup.find_all('meta'):
            for k, v in META:
                if m.get(k) == v and m.get('content'):
                    t = self.text(norm(m['content']))
                    if t is not None:
                        m['content'] = t


def head_block(path, lang):
    url = page_url(path)
    links = [f'<link rel="alternate" hreflang="en" href="{SITE}{url}">']
    for l in LANGS:
        links.append(f'<link rel="alternate" hreflang="{l}" href="{SITE}/{l}{url}">')
    links.append(f'<link rel="alternate" hreflang="x-default" href="{SITE}{url}">')
    style = ('<style>.lang-switch{display:inline-flex;align-items:center;gap:2px;margin-inline-end:10px;font-size:13px;font-weight:600;letter-spacing:.04em}'
             '.lang-switch a{color:rgba(255,255,255,.62);padding:6px 7px;border-radius:999px;text-decoration:none}'
             '.lang-switch a:hover{color:#fff}.lang-switch a[aria-current]{color:#fff;background:rgba(255,255,255,.12)}'
             '.lang-switch-m{display:none}@media(max-width:600px){.nav-right .lang-switch{display:none}.lang-switch.lang-switch-m{display:flex;gap:8px;margin:8px 0 0;font-size:15px}.lang-switch-m a{padding:8px 12px}}</style>')
    extra = ''
    if lang == 'fa':
        # Persian font + right-to-left fixes; Geist has no Persian letters.
        extra = ('<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
                 '<style>html[lang=fa] body,html[lang=fa] button,html[lang=fa] input,html[lang=fa] textarea{font-family:Vazirmatn,\'Geist\',sans-serif}'
                 'html[lang=fa] .h2,html[lang=fa] h1,html[lang=fa] h2{letter-spacing:0!important}'
                 'html[lang=fa] .kicker{letter-spacing:0}</style>')
    return MARK_HEAD[0] + '\n' + '\n'.join(links) + '\n' + style + extra + '\n' + MARK_HEAD[1] + '\n'


def switch_block(path, lang, extra_class=''):
    url = page_url(path)
    items = [('en', 'EN', url)] + [(l, LANGS[l]['label'], f'/{l}{url}') for l in LANGS]
    a = ''.join(f'<a href="{href}" hreflang="{l}" lang="{l}"' + (' aria-current="true"' if l == lang else '') + f'>{label}</a>'
                for l, label, href in items)
    return f'{MARK_SWITCH[0]}<div class="lang-switch{extra_class}" aria-label="Language">{a}</div>{MARK_SWITCH[1]}'


def inject(html, path, lang):
    html = html.replace('</head>', head_block(path, lang) + '</head>', 1)
    html = re.sub(r'(<div class="nav-right">)', lambda m: m.group(1) + switch_block(path, lang), html, count=1)
    # Phones: the header has no room, so a second copy sits at the end of the
    # menu (nav-links) and only that one shows below 600px.
    html = re.sub(r'(<nav class="nav-links" id="nav-links">.*?)(</nav>)',
                  lambda m: m.group(1) + switch_block(path, lang, ' lang-switch-m') + m.group(2), html, count=1, flags=re.S)
    return html


LEGAL = {'privacy-policy/index.html', 'terms/index.html', 'delete-account/index.html'}
LEGAL_NOTE = {
    'de': 'Dies ist eine Übersetzung zur Information. Rechtlich verbindlich ist die <a href="{en}">englische Fassung</a>.',
    'fa': 'این متن ترجمه‌ای برای آگاهی است. نسخهٔ حقوقی الزام‌آور، <a href="{en}">نسخهٔ انگلیسی</a> است.',
}


def legal_note(html, path, lang):
    """Translated legal pages say the English text is the binding one (shown after the first heading)."""
    if path not in LEGAL:
        return html
    note = ('<p class="i18n-legal-note" style="margin:16px 0;padding:12px 16px;border-radius:12px;'
            'background:#F1EEFF;color:#4B4C63;font-size:14px;line-height:1.5">'
            + LEGAL_NOTE[lang].replace('{en}', page_url(path)) + '</p>')
    return re.sub(r'(</h1>)', lambda m: m.group(1) + note, html, count=1)


def localize_href(href, lang):
    if not href.startswith('/') or href.startswith('//'):
        return href
    m = re.match(r'^(/[^?#]*)(.*)$', href)
    p, rest = m.group(1), m.group(2)
    if p.rstrip('/') in TRANSLATED_URLS or p == '/':
        return f'/{lang}{p}{rest}'
    return href


def load(lang):
    p = os.path.join(ROOT, 'i18n', f'{lang}.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}


def build():
    report = {}
    for path in PAGES:
        src_path = os.path.join(ROOT, path)
        src = strip_injected(open(src_path, encoding='utf-8').read())
        # English page: only the hreflang links + switch are (re)added.
        open(src_path, 'w', encoding='utf-8', newline='\n').write(inject(src, path, 'en'))
        for lang, cfg in LANGS.items():
            table = load(lang)
            soup = BeautifulSoup(src, 'html.parser')
            ps = Pass(table, lang)
            ps.walk(soup)
            ps.meta(soup)
            soup.html['lang'] = cfg['lang']
            soup.html['dir'] = cfg['dir']
            url = page_url(path)
            for link in soup.find_all('link', rel='canonical'):
                link['href'] = f'{SITE}/{lang}{url}'
            for m in soup.find_all('meta', property='og:url'):
                m['content'] = f'{SITE}/{lang}{url}'
            # Relative files ("screenshots/x.webp") would point inside /de/ — make
            # them absolute from the English page's folder first.
            base = '/' + os.path.dirname(path)
            for t in soup.find_all(True):
                for attr in ('src', 'href', 'poster'):
                    v = t.get(attr)
                    if isinstance(v, str) and v and not re.match(r"^([a-z]+:|/|#|\{|')", v):
                        t[attr] = posixpath.normpath(posixpath.join(base, v))
            for a in soup.find_all(['a', 'link'], href=True):
                if a.name == 'link':
                    continue
                a['href'] = localize_href(a['href'], lang)
            html = str(soup)
            # date/number locales used by the page scripts
            html = re.sub(r"(['\"])en-(GB|US)\1", lambda m: m.group(1) + cfg['locale'] + m.group(1), html)
            # Scripts that format with the visitor's browser language use the page's instead.
            html = re.sub(r"toLocale(Date|Time)?String\((undefined|\[\])",
                          lambda m: f"toLocale{m.group(1) or ''}String('{cfg['locale']}'", html)
            html = legal_note(html, path, lang)
            html = inject(html, path, lang)
            out = os.path.join(ROOT, lang, path)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            open(out, 'w', encoding='utf-8', newline='\n').write(html)
            for kind, key in ps.missing:
                report.setdefault(lang, {}).setdefault(kind, {}).setdefault(key, []).append(path)
    for lang in LANGS:
        miss = report.get(lang, {})
        n = sum(len(v) for v in miss.values())
        print(f'{lang}: {n} missing')
        json.dump(miss, open(os.path.join(ROOT, 'i18n', f'missing-{lang}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


def extract():
    out = {'text': {}, 'js': {}}
    for path in PAGES:
        src = strip_injected(open(os.path.join(ROOT, path), encoding='utf-8').read())
        soup = BeautifulSoup(src, 'html.parser')
        ps = Pass(None)
        ps.walk(soup)
        ps.meta(soup)
        for kind, key in ps.found:
            out[kind].setdefault(key, [])
            if path not in out[kind][key]:
                out[kind][key].append(path)
    json.dump(out, open(os.path.join(ROOT, 'i18n', 'source.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('text', len(out['text']), 'js', len(out['js']))


if __name__ == '__main__':
    {'extract': extract, 'build': build}[sys.argv[1]]()
