/**
 * JusticeLine ML Engine v2.0
 * Client-side NLP: Category prediction, Priority scoring, Sentiment analysis
 * Pure JavaScript — no external ML library needed, works offline.
 */
const MLEngine = (() => {

  // ─── CATEGORY KEYWORDS (weighted) ───────────────────────────────────────
  const CATEGORIES = {
    'Road Accident':         ['accident','crash','collision','vehicle','car','bike','motorcycle','road','traffic','hit and run','injured','pedestrian','overturn','drunk driving','rash'],
    'Fire Hazard':           ['fire','burn','flame','smoke','explosion','blaze','arson','inflammable','gas leak','chemical','electric fire','short circuit'],
    'Medical Emergency':     ['medical','hospital','ambulance','heart attack','unconscious','bleeding','overdose','seizure','stroke','injury','fainted','breathing','critical','cardiac'],
    'Crime in Progress':     ['crime','robbery','theft','murder','assault','stabbing','shooting','kidnap','rape','molestation','chain snatching','burglar','looting','gang'],
    'Gas Leak':              ['gas','lpg','cng','pipe burst','smell','leak','cylinder','valve','methane'],
    'Flood / Natural Disaster':['flood','waterlogging','cyclone','earthquake','landslide','storm','disaster','rain','submerged','overflow'],
    'Water Leakage':         ['water','leak','pipeline','tap','drainage','sewage','no water','burst pipe','contaminated','polluted water','borewell'],
    'Electricity Issue':     ['electricity','power cut','blackout','transformer','wire','electric','voltage','socket','no power','meter','lineman','streetlight','spark'],
    'Garbage Dumping':       ['garbage','trash','waste','dumping','litter','rubbish','smell','filth','overflowing','bin','sewage','hygiene','dirty'],
    'Road Damage':           ['pothole','road damage','broken road','crack','uneven','footpath','divider','signboard','road repair','speed breaker'],
    'Streetlight Issue':     ['streetlight','street light','dark','no light','bulb','lamp post','night','visibility','pole','blown fuse'],
    'Public Property Damage':['vandalism','damage','broken','graffiti','public property','bench','park','monument','bus stop','railway'],
    'Public Safety Threat':  ['threat','unsafe','dangerous','suspicious','weapon','bomb','explosive','security','crowd','mob'],
    'Harassment':            ['harassment','bully','intimidate','stalk','eve teasing','verbal abuse','threat','domestic violence','abuse','hostile'],
    'Child Safety':          ['child','minor','kid','school','abuse','trafficking','missing child','neglect','labour','exploitation'],
    'Women Safety':          ['women safety','woman','girl','molestation','eve teasing','domestic','dowry','discrimination','assault'],
    'Noise Pollution':       ['noise','loud','sound','music','speaker','horn','construction noise','night party','disturbing','nuisance'],
    'Corruption':            ['bribe','corruption','extortion','fraud','illegal','embezzlement','officer','official','money','nepotism','scam'],
    'Illegal Construction':  ['illegal construction','unauthorized','encroachment','demolish','building','structure','permit','violation'],
    'Land Dispute':          ['land','property','dispute','boundary','encroach','ownership','survey','title deed','plot','rent'],
    'Other':                 ['other','general','complaint','issue','problem','concern']
  };

  const DEPARTMENTS = {
    'Road Accident':          'Traffic & Road Safety',
    'Fire Hazard':            'Fire Department',
    'Medical Emergency':      'Health & Medical Services',
    'Crime in Progress':      'Police Department',
    'Gas Leak':               'Gas & Utilities',
    'Flood / Natural Disaster':'Disaster Management',
    'Water Leakage':          'Water & Sanitation',
    'Electricity Issue':      'Electricity Board',
    'Garbage Dumping':        'Municipal / Sanitation',
    'Road Damage':            'Public Works Department',
    'Streetlight Issue':      'Municipal Corporation',
    'Public Property Damage': 'Municipal Corporation',
    'Public Safety Threat':   'Police Department',
    'Harassment':             'Police / Women Cell',
    'Child Safety':           'Child Welfare',
    'Women Safety':           'Women Safety Cell',
    'Noise Pollution':        'Environment & Pollution',
    'Corruption':             'Anti-Corruption Bureau',
    'Illegal Construction':   'Town Planning',
    'Land Dispute':           'Revenue Department',
    'Other':                  'General Administration'
  };

  // ─── PRIORITY KEYWORDS ───────────────────────────────────────────────────
  const PRIORITY_WEIGHTS = {
    critical: ['death','dead','dying','murder','explosion','fire','bleeding','unconscious','bomb','critical','emergency','immediate','life','urgent','attack','rape','kidnap','heart attack','drowning','flood','disaster'],
    high:     ['accident','injury','injured','severe','serious','dangerous','unsafe','crime','violence','robbery','threat','assault','hospital','ambulance','help','stuck','gas leak','breakdown','collapsed'],
    medium:   ['damage','broken','repair','leak','pothole','no water','power cut','complaint','issue','problem','harassment','dispute','bribe','illegal'],
    low:      ['suggestion','feedback','general','inquiry','information','slow','delay','minor','small','noise']
  };

  // ─── SENTIMENT LEXICON ───────────────────────────────────────────────────
  const POSITIVE = ['resolved','fixed','good','great','excellent','appreciated','thank','happy','satisfied','working','better','perfect','improved'];
  const NEGATIVE = ['angry','worst','terrible','horrible','disgusting','useless','pathetic','frustrated','furious','worst','no action','ignored','helpless','screaming','traumatized','awful','fear','scared'];
  const INTENSIFIERS = ['very','extremely','absolutely','completely','totally','highly','really','so','too','beyond'];

  // ─── EMERGENCY CATEGORIES ────────────────────────────────────────────────
  const EMERGENCY_CATS = ['Road Accident','Fire Hazard','Medical Emergency','Crime in Progress','Gas Leak','Flood / Natural Disaster'];

  // ─── HELPERS ─────────────────────────────────────────────────────────────
  function tokenize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean);
  }

  function tfidfScore(tokens, keywords) {
    let score = 0;
    const tokenSet = tokens.join(' ');
    keywords.forEach((kw, i) => {
      const weight = 1 + (keywords.length - i) * 0.05; // earlier = more important
      const rx = new RegExp('\\b' + kw.replace(/\s+/g,'\\s+') + '\\b', 'gi');
      const matches = (tokenSet.match(rx) || []).length;
      score += matches * weight;
    });
    return score;
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────
  function analyzeText(text = '', existingCategory = '') {
    if (!text || text.trim().length < 3) {
      return { category: existingCategory||'Other', priority: 'Medium', sentiment: 'Neutral', department: 'General Administration', confidence: 0, isEmergency: false };
    }

    const tokens = tokenize(text);
    const fullText = tokens.join(' ');

    // ── 1. CATEGORY ──────────────────────
    let bestCat = existingCategory || 'Other';
    let bestScore = 0;
    const scores = {};
    Object.entries(CATEGORIES).forEach(([cat, kws]) => {
      const s = tfidfScore(tokens, kws);
      scores[cat] = s;
      if (s > bestScore) { bestScore = s; bestCat = cat; }
    });
    const totalScore = Object.values(scores).reduce((a,b)=>a+b,0)||1;
    const confidence = Math.min(99, Math.round((bestScore / totalScore) * 100 + (bestScore > 2 ? 20 : 0)));

    // ── 2. PRIORITY ──────────────────────
    let priScore = { critical:0, high:0, medium:0, low:0 };
    Object.entries(PRIORITY_WEIGHTS).forEach(([level, kws]) => {
      priScore[level] = tfidfScore(tokens, kws);
    });
    // Emergency categories get a priority boost
    if (EMERGENCY_CATS.includes(bestCat)) { priScore.critical += 3; }

    // Intensifiers boost
    const intCount = tokens.filter(t => INTENSIFIERS.includes(t)).length;
    priScore.high += intCount * 0.5;

    let priority = 'Medium';
    if (priScore.critical > 1) priority = 'Emergency';
    else if (priScore.high > 1.5) priority = 'High';
    else if (priScore.low > priScore.medium) priority = 'Low';

    // ── 3. SENTIMENT ─────────────────────
    let posScore = tfidfScore(tokens, POSITIVE);
    let negScore = tfidfScore(tokens, NEGATIVE);
    // Check for negations
    const negated = /\b(not|no|never|nothing|didn't|don't)\b/i.test(text);
    if (negated) { let tmp = posScore; posScore = negScore; negScore = tmp; }
    let sentiment = 'Neutral';
    if (negScore > posScore && negScore > 0.5) sentiment = 'Negative';
    else if (posScore > negScore && posScore > 0.5) sentiment = 'Positive';

    // ── 4. DEPARTMENT ────────────────────
    const department = DEPARTMENTS[bestCat] || 'General Administration';
    const isEmergency = EMERGENCY_CATS.includes(bestCat) || priority === 'Emergency';

    return { category: bestCat, priority, sentiment, department, confidence, isEmergency, scores };
  }

  // ── SENTIMENT COLOR/ICON ─────────────────────────────────────────────────
  function sentimentBadge(s) {
    const map = {
      Positive: { color:'#4ade80', icon:'😊', bg:'rgba(74,222,128,0.12)' },
      Neutral:  { color:'#94a3b8', icon:'😐', bg:'rgba(148,163,184,0.12)' },
      Negative: { color:'#f87171', icon:'😠', bg:'rgba(248,113,113,0.12)' }
    };
    return map[s] || map.Neutral;
  }

  function priorityBadge(p) {
    const map = {
      Emergency:{ color:'#ff4444', icon:'🚨', bg:'rgba(255,68,68,0.15)' },
      High:     { color:'#fb923c', icon:'🔴', bg:'rgba(251,146,60,0.12)' },
      Medium:   { color:'#fbbf24', icon:'🟡', bg:'rgba(251,191,36,0.12)' },
      Low:      { color:'#4ade80', icon:'🟢', bg:'rgba(74,222,128,0.12)' }
    };
    return map[p] || map.Medium;
  }

  return { analyzeText, sentimentBadge, priorityBadge, DEPARTMENTS };
})();

// Make available globally
window.MLEngine = MLEngine;
