// PLAY: playbooks that turn the terminal's screens into a decision, as prompts to paste into Claude.
import { esc } from "../api.js";
import { html } from "../ui.js";
import { PLAYBOOKS } from "../playbooks.js";

const copy = async (text, btn) => {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "COPIED";
  } catch {
    btn.textContent = "SELECT AND COPY";
  }
  setTimeout(() => (btn.textContent = btn.dataset.label), 1600);
};

export default [
  {
    id: "PLAY",
    name: "Playbooks: ways to use it with Claude",
    group: "Help",
    source: "Prompts that use this terminal's functions",
    render(ctx) {
      const pick =
        PLAYBOOKS.find((p) => p.id.toUpperCase() === ctx.args[0]) || null;
      ctx.el.innerHTML = "";
      ctx.el.append(
        html(
          `<p class="para">A terminal shows you the numbers. These turn them into a decision. Connect Claude first (type <b class="amber">ASK</b>), then paste a prompt. The ones marked BUILD add a permanent screen to your terminal. They help you trade better informed and better sized; none of them promises a profit.</p>`,
        ),
      );
      for (const p of pick ? [pick] : PLAYBOOKS) {
        const box =
          html(`<div style="border:1px solid var(--line);padding:8px 10px;margin:8px 0">
          <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b class="amber">${esc(p.title)}</b><span class="dim">${p.uses.map(esc).join(" · ")}</span></div>
          <p class="para" style="margin:6px 0">${esc(p.why)}</p>
          ${p.ask ? `<div class="para dim" style="margin:6px 0">ASK: ${esc(p.ask)}</div><button class="tab" data-k="ask" data-label="COPY ASK PROMPT">COPY ASK PROMPT</button>` : ""}
          ${p.build ? `<div class="para dim" style="margin:6px 0">BUILD: ${esc(p.build)}</div><button class="tab" data-k="build" data-label="COPY BUILD PROMPT">COPY BUILD PROMPT</button>` : ""}
        </div>`);
        box.addEventListener("click", (e) => {
          const b = e.target.closest("button[data-k]");
          if (b) copy(p[b.dataset.k], b);
        });
        ctx.el.append(box);
      }
      ctx.setSource(
        "Copy a prompt, then paste it into Claude Code with the terminal connected (ASK)",
      );
    },
  },
];
