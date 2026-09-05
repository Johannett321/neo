/* Neo landing page. GSAP + ScrollTrigger drive the scroll choreography; the
   download buttons read the latest release from GitHub and pick the visitor's OS. */

(function () {
  'use strict';

  const REPO = 'Johannett321/neo';
  const RELEASES = 'https://github.com/' + REPO + '/releases/latest';
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasGsap = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
  const motion = hasGsap && !reduced;

  /* ---------- Nav ---------- */
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- Split words ----------
     Wraps every word inside `el` in <span class="w">, keeping any element wrappers
     (mark, .serif, em) intact. With `inner`, each word also gets an inner span so it
     can slide up inside an overflow-hidden mask. */
  function splitWords(el, inner) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const parts = node.nodeValue.split(/(\s+)/);
      if (parts.every((p) => !p.trim())) return;
      const frag = document.createDocumentFragment();
      parts.forEach((p) => {
        if (!p) return;
        if (!p.trim()) { frag.appendChild(document.createTextNode(p)); return; }
        const w = document.createElement('span');
        w.className = 'w';
        if (inner) {
          const s = document.createElement('span');
          s.textContent = p;
          w.appendChild(s);
        } else {
          w.textContent = p;
        }
        frag.appendChild(w);
      });
      node.parentNode.replaceChild(frag, node);
    });
    return $$('.w', el);
  }

  const heroWords = splitWords($('[data-split]'), true);
  const manifestoWords = splitWords($('[data-split-words]'), false);

  if (!motion) {
    document.documentElement.classList.add('no-motion');
    $$('.reveal, .reveal-load').forEach((el) => { el.style.opacity = 1; el.style.transform = 'none'; });
    $$('[data-q]').forEach((q) => q.classList.add('is-active'));
    $$('[data-step]').forEach((s) => s.classList.add('is-on'));
    $$('.manifesto mark').forEach((m) => m.style.setProperty('--fill', 1));
    manifestoWords.forEach((w) => { w.style.color = ''; });
    $('[data-steps-line]').style.transform = 'none';
  } else {
    runMotion();
  }

  function runMotion() {
    gsap.registerPlugin(ScrollTrigger);
    gsap.defaults({ ease: 'power3.out' });
    const mm = gsap.matchMedia();

    /* Hero: words slide up, then the rest fades in. */
    const intro = gsap.timeline({ delay: 0.15 });
    intro
      .to(heroWords.map((w) => w.firstChild), { y: 0, duration: 1.1, stagger: 0.06, ease: 'power4.out' })
      .fromTo('.reveal-load', { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.9, stagger: 0.08 }, 0.35)
      .fromTo('[data-hero-window]', { opacity: 0, y: 60, rotateX: 22, scale: 0.94 },
        { opacity: 1, y: 0, rotateX: 14, scale: 0.96, duration: 1.4, ease: 'power3.out' }, 0.5)
      .fromTo('.chip', { opacity: 0, y: 30, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.9, stagger: 0.1 }, 1.1);

    /* Hero: the window flattens as you scroll into it; chips and glow drift at their
       own speeds. */
    gsap.to('[data-hero-window]', {
      rotateX: 0, scale: 1,
      ease: 'none',
      scrollTrigger: { trigger: '[data-hero-stage]', start: 'top 85%', end: 'top 25%', scrub: 0.6 },
    });
    $$('[data-float]').forEach((chip) => {
      const speed = parseFloat(chip.dataset.float);
      gsap.to(chip, {
        y: () => speed * 400,
        ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: 0.8 },
      });
      gsap.to(chip, { y: '+=8', duration: 2.4 + Math.random(), yoyo: true, repeat: -1, ease: 'sine.inOut' });
    });
    $$('[data-parallax]').forEach((el) => {
      gsap.to(el, {
        yPercent: parseFloat(el.dataset.parallax) * 100,
        ease: 'none',
        scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true },
      });
    });

    /* Generic reveals. */
    $$('.reveal').forEach((el) => {
      gsap.to(el, {
        opacity: 1, y: 0, duration: 1,
        scrollTrigger: { trigger: el, start: 'top 88%', once: true },
      });
    });

    /* Manifesto: pinned; the paragraph is read in as you scroll, and the marked
       phrases fill with colour when the reading reaches them. */
    (function manifesto() {
      const section = $('[data-manifesto]');
      const marks = $$('mark', section);
      const step = 1;
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: section, start: 'top top', end: '+=180%', pin: '.manifesto-inner', scrub: 0.5,
          anticipatePin: 1,
        },
      });
      tl.to(manifestoWords, { color: '#f5f5f7', duration: 4, stagger: step, ease: 'none' }, 0);
      marks.forEach((m) => {
        const first = $('.w', m);
        const idx = manifestoWords.indexOf(first);
        const count = $$('.w', m).length;
        tl.to(m, { '--fill': 1, duration: count * step * 1.2, ease: 'power1.inOut' }, idx * step);
      });
      tl.to({}, { duration: 6 }); /* hold at the end so the last line can be read */
    })();

    /* Three questions: pinned on desktop; the active question opens and the screenshot
       on the right swaps as you scroll. */
    mm.add('(min-width: 861px)', () => {
      const section = $('[data-questions]');
      const qs = $$('[data-q]', section);
      const shots = $$('[data-q-shot]', section);
      const n = qs.length;
      let current = 0;
      const setActive = (i) => {
        if (i === current) return;
        current = i;
        qs.forEach((q, k) => q.classList.toggle('is-active', k === i));
        shots.forEach((s, k) => s.classList.toggle('is-active', k === i));
      };
      const st = ScrollTrigger.create({
        trigger: section, start: 'top top', end: '+=' + (n * 100) + '%', pin: '.questions .wrap', scrub: true,
        anticipatePin: 1,
        onUpdate: (self) => {
          const p = self.progress * n;
          const i = Math.min(n - 1, Math.floor(p));
          setActive(i);
          qs.forEach((q, k) => {
            const local = Math.max(0, Math.min(1, p - k));
            q.style.setProperty('--p', local.toFixed(3));
          });
        },
      });
      return () => st.kill();
    });

    /* Feature cards: the grid stays put while the cards rise into place one by one. */
    mm.add('(min-width: 861px)', () => {
      const section = $('[data-features]');
      const cards = $$('[data-card]', section);
      gsap.set(cards, { opacity: 0, y: 160, rotateX: 18, transformOrigin: '50% 100%' });
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: section, start: 'top top', end: '+=140%', pin: '.features .wrap', scrub: 0.6,
          anticipatePin: 1,
        },
      });
      tl.to(cards, { opacity: 1, y: 0, rotateX: 0, duration: 1, stagger: 0.18, ease: 'power2.out' })
        .to({}, { duration: 0.6 });
      return () => { tl.scrollTrigger && tl.scrollTrigger.kill(); tl.kill(); gsap.set(cards, { clearProps: 'all' }); };
    });
    mm.add('(max-width: 860px)', () => {
      $$('[data-card]').forEach((c) => {
        gsap.fromTo(c, { opacity: 0, y: 40 }, {
          opacity: 1, y: 0, duration: 0.9,
          scrollTrigger: { trigger: c, start: 'top 90%', once: true },
        });
      });
    });

    /* Gallery: vertical scroll becomes horizontal travel while the section is pinned. */
    mm.add('(min-width: 861px)', () => {
      const section = $('[data-gallery]');
      const track = $('[data-track]', section);
      const bar = $('[data-gallery-progress]', section);
      const distance = () => track.scrollWidth - window.innerWidth;
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: section, start: 'top top', end: () => '+=' + distance(), pin: '.gallery-pin', scrub: 0.7,
          anticipatePin: 1, invalidateOnRefresh: true,
          onUpdate: (self) => { bar.style.transform = 'scaleX(' + self.progress + ')'; },
        },
      });
      tl.to(track, { x: () => -distance(), ease: 'none' }, 0)
        .fromTo($$('.slide img', section), { xPercent: -3 }, { xPercent: 3, ease: 'none' }, 0);
      return () => { tl.scrollTrigger && tl.scrollTrigger.kill(); tl.kill(); gsap.set(track, { clearProps: 'all' }); };
    });

    /* Recording: the line draws down the steps, lighting each one as it passes. */
    (function record() {
      const steps = $$('[data-step]');
      const line = $('[data-steps-line]');
      gsap.to(line, {
        scaleY: 1, ease: 'none',
        scrollTrigger: { trigger: '.steps', start: 'top 60%', end: 'bottom 60%', scrub: true },
      });
      steps.forEach((s) => {
        ScrollTrigger.create({
          trigger: s, start: 'top 62%',
          onEnter: () => s.classList.add('is-on'),
          onLeaveBack: () => s.classList.remove('is-on'),
        });
        gsap.fromTo(s, { opacity: 0.35, x: -8 }, {
          opacity: 1, x: 0, duration: 0.7,
          scrollTrigger: { trigger: s, start: 'top 75%', once: true },
        });
      });
      const visual = $('[data-record-visual]');
      gsap.fromTo(visual, { y: 40, opacity: 0 }, {
        y: 0, opacity: 1, duration: 1.1,
        scrollTrigger: { trigger: '[data-record]', start: 'top 70%', once: true },
      });
    })();

    /* Data: the folder tree types itself in. */
    gsap.to('[data-tree] .ln', {
      opacity: 1, x: 0, duration: 0.5, stagger: 0.07,
      scrollTrigger: { trigger: '[data-tree]', start: 'top 80%', once: true },
    });

    /* Download: the glow breathes. */
    gsap.to('.download-bg', {
      scale: 1.12, duration: 5, yoyo: true, repeat: -1, ease: 'sine.inOut', transformOrigin: '50% 60%',
    });

    /* Layout can shift as fonts and lazy images land; measure again. */
    window.addEventListener('load', () => ScrollTrigger.refresh());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => ScrollTrigger.refresh());
  }

  /* ---------- Downloads ----------
     Which platform the visitor is on, and the exact asset names from the latest
     release. Every link starts pointing at the releases page, so the page is right
     even if the API call fails or the release is still being built. */
  function detectPlatform() {
    const ua = navigator.userAgent || '';
    const plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/Mac|iPhone|iPad/i.test(plat) || /Macintosh/i.test(ua)) return 'mac';
    if (/Win/i.test(plat) || /Windows/i.test(ua)) return 'win';
    if (/Linux|X11|CrOS/i.test(plat + ua) && !/Android/i.test(ua)) return 'linux';
    return null;
  }

  const LABELS = { 'mac-arm': 'Download for macOS', 'mac-x64': 'Download for macOS', win: 'Download for Windows', linux: 'Download for Linux' };

  function classify(name) {
    if (/-arm64\.dmg$/i.test(name)) return 'mac-arm';
    if (/\.dmg$/i.test(name)) return 'mac-x64';
    if (/\.exe$/i.test(name)) return 'win';
    if (/\.AppImage$/i.test(name)) return 'linux';
    return null;
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  }

  async function wireDownloads() {
    const os = detectPlatform();
    /* Apple silicon and Intel cannot be told apart from a browser; default to arm64,
       which is what every Mac sold since 2020 is, and keep Intel one click away. */
    const preferred = os === 'mac' ? 'mac-arm' : os;
    const primaries = $$('[data-dl-primary]');
    const labels = $$('[data-dl-label]');
    const meta = $('[data-dl-meta]');
    const cards = $$('[data-platform]');

    if (preferred) {
      labels.forEach((l) => { l.textContent = LABELS[preferred]; });
      cards.forEach((c) => c.classList.toggle('is-current', c.dataset.platform === preferred));
    }

    let release;
    try {
      const res = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(res.status);
      release = await res.json();
    } catch (e) {
      return; /* links already point at the releases page */
    }

    const assets = {};
    (release.assets || []).forEach((a) => {
      const k = classify(a.name);
      if (k && !assets[k]) assets[k] = a;
    });

    const tag = release.tag_name || '';
    $$('[data-version]').forEach((v) => { v.textContent = tag; });

    cards.forEach((c) => {
      const a = assets[c.dataset.platform];
      const file = $('[data-file]', c);
      if (a) {
        c.href = a.browser_download_url;
        file.textContent = a.name + (a.size ? ' · ' + fmtSize(a.size) : '');
        c.classList.remove('is-missing');
      } else {
        c.classList.add('is-missing');
        file.textContent = 'Not in this release yet';
      }
    });

    const chosen = preferred && assets[preferred];
    if (chosen) {
      primaries.forEach((p) => { p.href = chosen.browser_download_url; });
      if (meta) {
        const date = release.published_at ? new Date(release.published_at) : null;
        const when = date ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        meta.textContent = tag + ' · ' + chosen.name + ' · ' + fmtSize(chosen.size) + (when ? ' · ' + when : '');
      }
    } else if (meta) {
      meta.textContent = tag + ' · all downloads on GitHub';
    }
  }

  wireDownloads();
})();
