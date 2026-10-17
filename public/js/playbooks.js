// Playbooks: ready-made prompts that turn what the terminal shows into a decision. Each one has an "ask" prompt
// (paste into Claude once it's connected: type ASK in the app) and, where it makes sense, a "build" prompt that
// adds it to the terminal as a permanent screen. Shown on the PLAY screen.
// They help you trade better informed and better sized. None of them promises a profit.
export const PLAYBOOKS = [
  {
    id: "brief",
    title: "Your morning brief",
    why: "Two minutes before the open and you know what moved overnight, what's scheduled today and what the Fed is priced to do, instead of finding out from your P&L.",
    uses: ["WEI", "CRYPTO", "TOP", "ECO", "WIRP", "W", "ERN"],
    ask: "Using my Amber Terminal, give me this morning's brief in under 12 lines: what world markets and crypto did overnight (WEI, CRYPTO), the three headlines that matter most for my watchlist (TOP, W), today's economic releases with the consensus (ECO), what futures price for the next Fed meeting and how that changed since yesterday (WIRP), and anything on my watchlist with earnings this week (ERN). End with the one thing to watch today.",
    build:
      "Add a function called BRIEF to Amber Terminal that puts this morning brief on one screen, built from the existing functions' data and refreshed every 15 minutes. Follow the README's 'Add your own screen' section and add a test.",
  },
  {
    id: "earnings",
    title: "Earnings: is the move already priced?",
    why: "Options tell you how far the market expects a stock to move on earnings. Compare that with how far it usually moves and you know whether options are cheap or expensive, and how big a position the likely move allows.",
    uses: ["ERN", "OMON", "OVDV", "HP", "INSD"],
    ask: "NVDA reports this week (check ERN for the date). From my Amber Terminal: get the implied move to the first expiry after the report (OMON) and the at-the-money volatility across the next expiries (OVDV), then how far NVDA actually moved the day after each of its last 8 reports (use its daily history around those dates). Is the market pricing a bigger or smaller move than NVDA usually makes? Show the expected range in dollars, and what a $2,000 position would gain or lose at each edge of it. Mention any insider buying or selling in the last 60 days (INSD).",
    build:
      "Add a function called EMOVE to Amber Terminal: for the panel's stock, show the implied earnings move from the options chain next to its actual moves after the last 8 reports, with the average and a note saying whether options are pricing more or less than usual.",
  },
  {
    id: "fed",
    title: "Fed day: what's already in the price",
    why: "Markets move on surprises, not on what everyone expected. Knowing what's priced stops you trading a headline that was already in the price.",
    uses: ["WIRP", "GC", "BTMM", "CRED", "FXC"],
    ask: "Before the next Fed meeting, using my Amber Terminal: what does WIRP price for it and the three after, and how has that changed this week? Where are the 2-year and 10-year yields and the 2s10s spread (GC, BTMM)? Are credit spreads widening or tightening (CRED)? Then tell me what decision would surprise the market, and how the S&P 500 and the dollar moved on the last three meeting days, so I know what a surprise has looked like.",
  },
  {
    id: "insiders",
    title: "Insiders buying their own stock",
    why: "When the people running a company buy its shares with their own money on the open market, it's one of the few signals the public can see. This finds it across your list in a minute.",
    uses: ["W", "INSD", "CF", "DES"],
    ask: "For every stock on my Amber Terminal watchlist (W), plus AAPL, MSFT and JPM, check insider transactions in the last 60 days (INSD). List only open-market purchases: who bought, their role, the dollar amount, and how big that is next to what they already own. Then check each company's 8-K filings since (CF) for anything that explains it.",
    build:
      "Add a function called IBUY to Amber Terminal that scans my watchlist for open-market insider purchases in the last 60 days and ranks them by dollar size, using the INSD data.",
  },
  {
    id: "sentiment",
    title: "Headline sentiment across your list",
    why: "Funds pay for news sentiment scores. Claude can read the latest headlines for each stock on your list, score the tone and tell you which ones turned, so you look at the right charts first.",
    uses: ["W", "CN", "TOP"],
    ask: "For every stock on my Amber Terminal watchlist (W), read the latest headlines (CN) and score the tone of the news from -2 (very negative) to +2 (very positive), with one line on why. Then list the ones whose news turned sharply in the last few days, and the headline that did it. Don't guess a stock's direction from this, just tell me where to look.",
    build: "Add a function called SENT to Amber Terminal that shows my watchlist with the latest headline for each stock and a column for a sentiment score I can fill in by asking Claude, saved in the data folder so I can see how it changes day to day.",
  },
  {
    id: "redflags",
    title: "Red flags in the filings",
    why: "Words like 'going concern', 'material weakness' or 'restatement' in a filing often come before bad news. Searching every filing for them used to need a research desk.",
    uses: ["DS", "CF", "W"],
    ask: "Using my Amber Terminal's document search (DS), check the last year of 10-K and 10-Q filings for every company on my watchlist (W) for these phrases: going concern, material weakness, restatement, auditor resignation, covenant breach. For each hit, give me the company, the filing, the date and the sentence it appears in. Then tell me which ones look serious and which are routine wording.",
  },
  {
    id: "hedge",
    title: "What it costs to protect your portfolio",
    why: "Before a big event you can buy protection. Knowing what three months of cover costs, in dollars and as a share of your portfolio, tells you whether it's worth it.",
    uses: ["PORT", "OMON", "OVDV"],
    ask: "Read my portfolio in Amber Terminal (PORT) and its beta to the S&P 500. Work out how many SPY put contracts would cover a 10% fall in the S&P for about three months, using real prices from the SPY options chain (OMON) at a strike around 5% below today's price. Tell me the total cost in dollars, the cost as a percentage of my portfolio, and what the at-the-money volatility (OVDV) says about whether protection is cheap or expensive right now.",
  },
  {
    id: "surprise",
    title: "Which data surprises move the market",
    why: "Not every release matters. Seeing how far the S&P and yields moved the last few times CPI or payrolls surprised tells you which numbers to be careful around.",
    uses: ["SURP", "ECO", "GC"],
    ask: "Using my Amber Terminal (SURP and ECO), show me the last few CPI, payrolls and retail sales releases: actual against consensus, and how the S&P 500 and the 10-year yield moved that day. Which surprises moved the market most, and what's due this week that could do the same?",
  },
  {
    id: "lab",
    title: "Edge or luck? Test the idea first",
    why: "Most strategies that look great on a chart are luck. This tests yours on years of data and runs the checks quant desks use, before you put money behind it.",
    uses: ["BTST"],
    ask: "Using my Amber Terminal's backtester (BTST), test this idea on SPY, QQQ and BTC daily: buy when the price closes above its 200-day average and RSI(14) is under 60, sell when it closes back below the 200-day. Run the quant checks on each and tell me plainly whether it looks like an edge or luck. If it fails, change one thing and test again, at most three rounds, and show me every result including the failures, so I can see how many tries it took.",
  },
  {
    id: "risk",
    title: "Your portfolio's real risk",
    why: "Knowing how much you'd lose if the market fell 10%, and which holding drives it, is the difference between sizing a trade and guessing.",
    uses: ["PORT", "ERN", "DVD", "HP"],
    ask: "Read my portfolio in Amber Terminal (PORT). Tell me its beta to the S&P 500, which holding carries the most risk, which holdings report earnings or go ex-dividend in the next two weeks (ERN, DVD), and roughly how much the portfolio would lose if the S&P 500 fell 10%, using each holding's beta. Keep it to the numbers and one suggestion.",
  },
  {
    id: "curve",
    title: "What the futures curve costs an ETF holder",
    why: "Commodity ETFs roll their futures every month. In contango that quietly costs holders; in backwardation it pays them. Most people holding USO or UNG don't know which.",
    uses: ["CT", "GLCO"],
    ask: "Using my Amber Terminal, is crude oil in contango or backwardation right now (CL1 COMDTY CT), and how about natural gas (NG1 COMDTY CT)? Explain in plain words what that means for someone holding an oil ETF like USO for six months, and how much the curve has changed this month.",
  },
  {
    id: "screen",
    title: "Add the screen you wish it had",
    why: "The terminal is yours. If it's missing the screen you check every day, Claude adds it in a few minutes, as a new function code.",
    uses: ["MOST", "EQS"],
    build:
      "Add a function called SECT to Amber Terminal that shows today's performance by sector from the stock screener's data: each sector's average move, its biggest gainer and loser, and click a stock to open its DES. Follow the README's 'Add your own screen' section and add a test.",
  },
];
