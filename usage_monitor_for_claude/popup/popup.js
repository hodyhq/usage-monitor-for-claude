let els;
let statusState = {};
let translations = {};
let textTimerId = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 26;
const RING_CENTER = 32;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Set CSS custom properties for theme colors and inject translation strings.
 *
 * Called once by Python after the page loads.  Translations are set as
 * textContent on heading elements so the HTML file stays language-neutral.
 *
 * @param {object} config - { colors, t (translations), app_version, data (initial snapshot) }
 */
function init(config) {
    const s = document.documentElement.style;
    for (const [key, value] of Object.entries(config.colors)) {
        s.setProperty(`--${key.replaceAll('_', '-')}`, value);
    }

    translations = config.t;
    document.getElementById('title').textContent = translations.title;
    document.getElementById('headingAccount').textContent = translations.account;
    document.getElementById('labelEmail').textContent = translations.email;
    document.getElementById('labelPlan').textContent = translations.plan;
    document.getElementById('headingByModel').textContent = translations.by_model;
    document.getElementById('headingExtraUsage').textContent = translations.extra_usage;
    document.getElementById('headingTokens').textContent = translations.todays_tokens;
    document.getElementById('tokensNote').textContent = translations.tokens_local;
    document.getElementById('headingClaudeCode').textContent = translations.claude_code;

    const changelogLink = document.getElementById('changelogLink');
    changelogLink.textContent = translations.changelog;
    changelogLink.addEventListener('click', () => pywebview.api.open_url());
    document.getElementById('closeBtn').addEventListener('click', () => pywebview.api.close());

    document.getElementById('appVersion').textContent = config.app_version;

    els = {
        planChip: document.getElementById('planChip'),
        accountSection: document.getElementById('accountSection'),
        emailRow: document.getElementById('emailRow'),
        emailValue: document.getElementById('emailValue'),
        planRow: document.getElementById('planRow'),
        planValue: document.getElementById('planValue'),
        usageSection: document.getElementById('usageSection'),
        usageRings: document.getElementById('usageRings'),
        modelSection: document.getElementById('modelSection'),
        modelBars: document.getElementById('modelBars'),
        extraSection: document.getElementById('extraSection'),
        extraSpent: document.getElementById('extraSpent'),
        extraPct: document.getElementById('extraPct'),
        extraFill: document.getElementById('extraFill'),
        tokensSection: document.getElementById('tokensSection'),
        tokenRows: document.getElementById('tokenRows'),
        installSection: document.getElementById('installSection'),
        installRows: document.getElementById('installRows'),
        statusSection: document.getElementById('statusSection'),
        statusText: document.getElementById('statusText'),
    };

    updateData(config.data);
    requestAnimationFrame(() => document.body.classList.add('open'));
}

/**
 * Update all popup sections with fresh data from Python.
 *
 * @param {object} data - Pre-formatted snapshot from _snapshot_to_dict().
 */
function updateData(data) {
    const hasProfile = !!data.profile;
    els.accountSection.classList.toggle('visible', hasProfile);
    const plan = hasProfile ? data.profile.plan : '';
    els.planChip.textContent = plan;
    els.planChip.classList.toggle('visible', !!plan);
    if (hasProfile) {
        els.emailValue.textContent = data.profile.email;
        els.emailRow.style.display = data.profile.email ? '' : 'none';
        els.planValue.textContent = data.profile.plan;
        els.planRow.style.display = data.profile.plan ? '' : 'none';
    }

    const rings = (data.usage || []).filter((entry) => !entry.is_model);
    const models = (data.usage || []).filter((entry) => entry.is_model);

    els.usageSection.classList.toggle('visible', rings.length > 0);
    if (rings.length > 0) {
        updateRings(rings);
    }

    els.modelSection.classList.toggle('visible', models.length > 0);
    if (models.length > 0) {
        updateUsageBars(models);
    }

    const hasExtra = !!data.extra;
    els.extraSection.classList.toggle('visible', hasExtra);
    if (hasExtra) {
        els.extraSpent.textContent = data.extra.spent_text;
        els.extraPct.textContent = data.extra.pct_text;
        els.extraFill.style.width = `${data.extra.fill_pct * 100}%`;
    }

    const hasTokens = !!data.tokens?.length;
    els.tokensSection.classList.toggle('visible', hasTokens);
    if (hasTokens) {
        els.tokenRows.replaceChildren(...data.tokens.map((entry) => {
            const row = document.createElement('div');
            const dt = document.createElement('dt');
            dt.textContent = entry.name;
            const dd = document.createElement('dd');
            const out = document.createElement('span');
            out.className = 'token-out';
            out.textContent = `${entry.output_text} ${translations.tokens_out}`;
            const total = document.createElement('span');
            total.className = 'token-total';
            total.textContent = entry.total_text;
            dd.append(out, total);
            row.append(dt, dd);
            return row;
        }));
    }

    const hasInstalls = !!data.installations?.length;
    els.installSection.classList.toggle('visible', hasInstalls);
    if (hasInstalls) {
        els.installRows.replaceChildren(...data.installations.map((inst) => {
            const row = document.createElement('div');
            const dt = document.createElement('dt');
            dt.textContent = inst.name;
            const dd = document.createElement('dd');
            dd.textContent = inst.version;
            row.append(dt, dd);
            return row;
        }));
    }

    updateStatus(data.status);
}

/**
 * Update the status footer with live timer data or static text.
 *
 * Live mode (has last_success_time): starts a 1-second interval for
 * the text counter.  Static mode (has text): shows plain text.
 */
function updateStatus(status) {
    if (textTimerId) {
        clearInterval(textTimerId);
        textTimerId = null;
    }

    if (!status) {
        els.statusSection.classList.remove('visible');
        return;
    }

    els.statusSection.classList.add('visible');

    if (status.last_success_time !== undefined) {
        statusState = {
            lastSuccessTime: status.last_success_time,
            nextPollTime: status.next_poll_time,
            refreshing: status.refreshing,
            error: status.error,
        };
        els.statusSection.classList.toggle('error', !!status.error);
        tickStatusText();
        textTimerId = setInterval(tickStatusText, 1000);
    } else {
        statusState = {};
        els.statusText.textContent = status.text || '';
        els.statusSection.classList.toggle('error', !!status.is_error);
    }
}

/**
 * Build and display the status text from current state.
 *
 * < 60s:  "Updated Xs ago"
 * >= 60s: "Updated Xm ago · Next update in Ym"
 * + refreshing or error appended with · separator
 */
function tickStatusText() {
    if (!statusState.lastSuccessTime) return;

    const now = Date.now() / 1000;
    const secondsAgo = Math.max(0, Math.floor(now - statusState.lastSuccessTime));
    const isStale = !!statusState.nextPollTime && (now > statusState.nextPollTime + 30);
    els.usageSection.classList.toggle('stale', isStale);
    els.modelSection.classList.toggle('stale', isStale);
    els.extraSection.classList.toggle('stale', isStale);

    const parts = [formatDuration(secondsAgo)];

    if (statusState.refreshing) {
        parts.push(translations.status_refreshing);
    } else if (statusState.error) {
        parts.push(statusState.error);
    } else if (secondsAgo >= 60 && statusState.nextPollTime) {
        const secondsUntil = Math.max(0, Math.floor(statusState.nextPollTime - now));
        if (secondsUntil > 0) {
            parts.push(translations.status_next_update.replace('{duration}', formatCountdown(secondsUntil)));
        }
    }

    els.statusText.textContent = parts.join(' · ');
}

/**
 * Format seconds into a localized "Updated Xs ago" / "Updated Xm ago" string.
 */
function formatDuration(totalSeconds) {
    if (totalSeconds < 60) {
        return translations.status_updated_s.replace('{s}', totalSeconds);
    }

    const totalMin = Math.floor(totalSeconds / 60);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;

    let duration;
    if (hours > 0) {
        duration = translations.duration_hm.replace('{h}', hours).replace('{m}', mins);
    } else {
        duration = translations.duration_m.replace('{m}', totalMin);
    }
    return translations.status_updated.replace('{duration}', duration);
}

/**
 * Format a countdown in seconds into a localized duration string.
 */
function formatCountdown(totalSeconds) {
    if (totalSeconds < 60) {
        return translations.duration_s.replace('{s}', totalSeconds);
    }

    const totalMin = Math.ceil(totalSeconds / 60);
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;

    if (hours > 0) {
        return translations.duration_hm.replace('{h}', hours).replace('{m}', mins);
    }
    return translations.duration_m.replace('{m}', totalMin);
}

/* ------------------------------------------------------------------ */
/* Rings (base usage periods)                                          */
/* ------------------------------------------------------------------ */

function updateRings(entries) {
    if (entries.length !== els.usageRings.children.length) {
        els.usageRings.replaceChildren(...entries.map(createRingElement));
        requestAnimationFrame(() => {
            for (let i = 0; i < entries.length; i++) {
                applyRingState(els.usageRings.children[i], entries[i]);
            }
        });
    } else {
        for (let i = 0; i < entries.length; i++) {
            updateRingElement(els.usageRings.children[i], entries[i]);
        }
    }
}

function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}

function createRingElement(entry) {
    const div = document.createElement('div');
    div.className = 'ring-entry';

    const svg = svgEl('svg', { viewBox: '0 0 64 64' });
    svg.appendChild(svgEl('circle', {
        class: 'ring-track', cx: RING_CENTER, cy: RING_CENTER, r: RING_RADIUS,
    }));
    const fill = svgEl('circle', {
        class: 'ring-fill', cx: RING_CENTER, cy: RING_CENTER, r: RING_RADIUS,
        'stroke-dasharray': `0 ${RING_CIRCUMFERENCE}`,
    });
    svg.appendChild(fill);
    const pct = svgEl('text', { class: 'ring-pct', x: RING_CENTER, y: RING_CENTER });
    svg.appendChild(pct);
    div.appendChild(svg);

    const label = document.createElement('div');
    label.className = 'ring-label';
    label.textContent = entry.label;
    div.appendChild(label);

    const reset = document.createElement('div');
    reset.className = 'reset-text';
    div.appendChild(reset);

    return div;
}

/**
 * Apply percentage fill, warn color, time marker, and texts to a ring.
 *
 * The time marker is a small dot on the ring track at the angle matching
 * the elapsed portion of the period (same data as the bar time marker).
 */
function applyRingState(div, entry) {
    const fill = div.querySelector('.ring-fill');
    fill.setAttribute('stroke-dasharray', `${entry.fill_pct * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`);
    fill.classList.toggle('warn', entry.warn);

    div.querySelector('.ring-pct').textContent = entry.pct_text;

    const svg = div.querySelector('svg');
    let marker = svg.querySelector('.ring-marker');
    if (entry.marker_rel !== null) {
        const angle = entry.marker_rel * 2 * Math.PI - Math.PI / 2;
        const cx = RING_CENTER + RING_RADIUS * Math.cos(angle);
        const cy = RING_CENTER + RING_RADIUS * Math.sin(angle);
        if (!marker) {
            marker = svgEl('circle', { class: 'ring-marker', r: 2.2 });
            svg.appendChild(marker);
        }
        marker.setAttribute('cx', cx.toFixed(2));
        marker.setAttribute('cy', cy.toFixed(2));
    } else if (marker) {
        marker.remove();
    }

    div.querySelector('.reset-text').textContent = entry.reset_text || '';
}

function updateRingElement(div, entry) {
    div.querySelector('.ring-label').textContent = entry.label;
    applyRingState(div, entry);
}

/* ------------------------------------------------------------------ */
/* Bars (model variants and extra usage)                               */
/* ------------------------------------------------------------------ */

function updateUsageBars(entries) {
    if (entries.length !== els.modelBars.children.length) {
        els.modelBars.replaceChildren(...entries.map(createBarElement));
        requestAnimationFrame(() => {
            for (let i = 0; i < entries.length; i++) {
                els.modelBars.children[i].querySelector('.bar-fill').style.width =
                    `${entries[i].fill_pct * 100}%`;
            }
        });
    } else {
        for (let i = 0; i < entries.length; i++) {
            updateBarElement(els.modelBars.children[i], entries[i]);
        }
    }
}

function createBarElement(entry) {
    const div = document.createElement('div');
    div.className = 'usage-entry';

    const header = document.createElement('div');
    header.className = 'bar-header';
    const label = document.createElement('span');
    label.textContent = entry.label;
    const pct = document.createElement('span');
    pct.className = 'bar-pct';
    pct.textContent = entry.pct_text;
    header.append(label, pct);

    const container = document.createElement('div');
    container.className = 'bar-container';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.classList.toggle('warn', entry.warn);
    fill.style.width = '0%';
    container.appendChild(fill);

    for (const pos of entry.midnights) {
        const d = document.createElement('div');
        d.className = 'bar-divider';
        d.style.left = `calc(${pos * 100}% - 1px)`;
        container.appendChild(d);
    }

    if (entry.marker_rel !== null) {
        const marker = document.createElement('div');
        marker.className = 'bar-marker';
        marker.style.left = `calc(${entry.marker_rel * 100}% - 1px)`;
        container.appendChild(marker);
    }

    div.append(header, container);

    if (entry.reset_text) {
        const reset = document.createElement('div');
        reset.className = 'reset-text';
        reset.textContent = entry.reset_text;
        div.appendChild(reset);
    }

    return div;
}

function updateBarElement(div, entry) {
    div.querySelector('.bar-pct').textContent = entry.pct_text;

    const fill = div.querySelector('.bar-fill');
    fill.style.width = `${entry.fill_pct * 100}%`;
    fill.classList.toggle('warn', entry.warn);

    const container = div.querySelector('.bar-container');
    let marker = container.querySelector('.bar-marker');
    if (entry.marker_rel !== null) {
        if (!marker) {
            marker = document.createElement('div');
            marker.className = 'bar-marker';
            container.appendChild(marker);
        }
        marker.style.left = `${entry.marker_rel * 100}%`;
    } else if (marker) {
        marker.remove();
    }

    for (const d of container.querySelectorAll('.bar-divider')) d.remove();
    for (const pos of entry.midnights) {
        const d = document.createElement('div');
        d.className = 'bar-divider';
        d.style.left = `${pos * 100}%`;
        container.appendChild(d);
    }

    let resetEl = div.querySelector('.reset-text');
    if (entry.reset_text) {
        if (resetEl) {
            resetEl.textContent = entry.reset_text;
        } else {
            resetEl = document.createElement('div');
            resetEl.className = 'reset-text';
            resetEl.textContent = entry.reset_text;
            div.appendChild(resetEl);
        }
    } else if (resetEl) {
        resetEl.remove();
    }
}

// Report content height changes to the host (pywebview or dev.html iframe parent).
new ResizeObserver(() => {
    const height = document.body.scrollHeight;
    if (window.pywebview?.api?.report_height) {
        pywebview.api.report_height(height);
    }
}).observe(document.body);
