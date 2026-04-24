import React, { useState, useEffect } from "react";
import { Camera, LayoutDashboard, History as HistoryIcon, CheckCircle2, XCircle, Info, Loader2, Warehouse, ArrowRight, TrendingUp, PieChart as PieChartIcon, LogOut, Globe, Languages } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, AreaChart, Area } from "recharts";
import { GoogleGenAI } from "@google/genai";
import { collection, addDoc, query, where, orderBy, getDocs, serverTimestamp, Timestamp, doc, getDocFromCache, getDocFromServer } from "firebase/firestore";
import { db, auth, googleProvider, signInWithPopup, onAuthStateChanged, User } from "./lib/firebase";

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const MODEL_NAME = "gemini-3-flash-preview";

interface QualityResult {
  quality: "GOOD" | "BAD";
  score: number;
  reason: string;
}

interface HistoryItem extends QualityResult {
  id: string;
  imageName: string;
  timestamp: any;
}

interface Stats {
  total: number;
  avgScore: number;
  goodCount: number;
  badCount: number;
  estimatedEarnings: number;
}

const COLORS = ["#10b981", "#f43f5e"];

const INDIAN_LANGUAGES = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi (हिंदी)" },
  { code: "gu", name: "Gujarati (ગુજરાતી)" },
  { code: "mr", name: "Marathi (मराठी)" },
  { code: "ta", name: "Tamil (தமிழ்)" },
  { code: "te", name: "Telugu (తెలుగు)" },
  { code: "kn", name: "Kannada (ಕನ್ನಡ)" },
  { code: "bn", name: "Bengali (বাংলা)" },
  { code: "pa", name: "Punjabi (ਪੰਜਾਬੀ)" },
  { code: "ml", name: "Malayalam (മലയാളം)" },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [selectedLang, setSelectedLang] = useState(INDIAN_LANGUAGES[0]);
  const [langSearch, setLangSearch] = useState("");
  const [isLangOpen, setIsLangOpen] = useState(false);
  const [view, setView] = useState<"picker" | "dashboard">("picker");
  const [earnings, setEarnings] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QualityResult | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, "test", "connection"));
      } catch (error) {
        if (error instanceof Error && error.message.includes("the client is offline")) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (user && view === "dashboard") {
      fetchStats();
      fetchHistory();
    }
  }, [view, user]);

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (e) {
      console.error("Login failed:", e);
    }
  };

  const handleLogout = () => auth.signOut();

  const fetchStats = async () => {
    if (!user) return;
    try {
      const q = query(collection(db, "checks"), where("userId", "==", user.uid));
      const querySnapshot = await getDocs(q);
      
      let total = 0;
      let totalScore = 0;
      let goodCount = 0;
      let badCount = 0;

      querySnapshot.forEach((doc) => {
        const data = doc.data() as HistoryItem;
        total++;
        totalScore += data.score;
        if (data.quality === "GOOD") goodCount++;
        else badCount++;
      });

      setStats({
        total,
        avgScore: total > 0 ? totalScore / total : 0,
        goodCount,
        badCount,
        estimatedEarnings: total * 0.45
      });
    } catch (e) {
      console.error(e);
    }
  };

  const fetchHistory = async () => {
    if (!user) return;
    try {
      const q = query(
        collection(db, "checks"), 
        where("userId", "==", user.uid),
        orderBy("timestamp", "desc")
      );
      const querySnapshot = await getDocs(q);
      const items: HistoryItem[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        items.push({
          id: doc.id,
          ...data,
          // Handle Firestore Timestamp
          timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate().toISOString() : data.timestamp
        } as HistoryItem);
      });
      setHistory(items);
    } catch (e) {
      console.error(e);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Show preview and prepare base64
    const reader = new FileReader();
    reader.onloadend = async () => {
      const dataUrl = reader.result as string;
      setPreview(dataUrl);
      
      setLoading(true);
      setResult(null);

      try {
        const base64Data = dataUrl.split(",")[1];
        
        const prompt = `
          Analyze this image of a fruit or vegetable for a grocery shop quality check.
          Decide if it is GOOD or BAD quality (freshness, bruises, mold, damage).
          Provide:
          1. A status: either "GOOD" or "BAD".
          2. A numeric quality score from 0 to 100.
          3. A brief reason for the score (max 10 words).
          
          CRITICAL: Provide the "reason" in the following language: ${selectedLang.name}.
          If the language is not English, use the native script of that language.
          
          Respond ONLY in JSON format:
          { "quality": "GOOD" | "BAD", "score": number, "reason": string }
        `;

        const response = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: [{
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: file.type,
                  data: base64Data
                }
              }
            ]
          }],
          config: {
            responseMimeType: "application/json"
          }
        });

        const analysis = JSON.parse(response.text || "{}");
        setResult(analysis);

        // Save to Firestore
        if (user) {
          await addDoc(collection(db, "checks"), {
            ...analysis,
            userId: user.uid,
            imageName: file.name,
            timestamp: serverTimestamp()
          });
          
          // Refresh stats and history locally
          fetchStats();
          fetchHistory();
        }

      } catch (err) {
        console.error("AI Analysis Error:", err);
      } finally {
        setLoading(false);
      }
    };
    reader.readAsDataURL(file);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center space-y-8">
        <div className="space-y-4">
          <div className="mx-auto h-20 w-20 rounded-3xl bg-indigo-50 flex items-center justify-center text-indigo-600">
            <Warehouse className="h-10 w-10" />
          </div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900">Smart Quality</h1>
          <p className="text-slate-500 max-w-xs mx-auto">AI-powered quality delivery system for the modern grocery supply chain.</p>
        </div>
        
        <button
          onClick={handleLogin}
          className="w-full max-w-xs flex items-center justify-center gap-3 bg-slate-900 text-white font-bold py-4 px-6 rounded-2xl hover:bg-slate-800 transition-all shadow-xl shadow-slate-200"
        >
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="h-5 w-5" alt="Google" />
          Continue with Google
        </button>
        
        <p className="text-[10px] uppercase font-bold tracking-widest text-slate-400">Secure Email Login Required</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {/* Header */}
      <header className="fixed top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-lg items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Warehouse className="h-6 w-6 text-indigo-600" />
            <h1 className="text-lg font-bold tracking-tight">SmartQuality</h1>
          </div>
          <div className="flex items-center gap-3">
             {/* Language Selector */}
             <div className="relative">
               <button 
                 onClick={() => setIsLangOpen(!isLangOpen)}
                 className="flex items-center gap-2 bg-slate-50 border border-slate-100 hover:border-indigo-200 text-slate-700 transition-all px-3 py-1.5 rounded-xl shadow-sm hover:shadow-md"
               >
                 <Languages className="h-4 w-4 text-indigo-500" />
                 <span className="text-xs font-bold whitespace-nowrap">{selectedLang.name.split(' ')[0]}</span>
               </button>

               <AnimatePresence>
                 {isLangOpen && (
                   <>
                     {/* Backdrop for click-away */}
                     <div 
                       className="fixed inset-0 z-10" 
                       onClick={() => setIsLangOpen(false)} 
                     />
                     <motion.div 
                       initial={{ opacity: 0, y: 10, scale: 0.95 }}
                       animate={{ opacity: 1, y: 0, scale: 1 }}
                       exit={{ opacity: 0, y: 10, scale: 0.95 }}
                       className="absolute right-0 top-full mt-2 z-20 w-56 bg-white border border-slate-100 rounded-2xl shadow-2xl overflow-hidden py-2"
                     >
                       <div className="px-3 pb-2 pt-1">
                         <div className="relative">
                           <input
                             type="text"
                             autoFocus
                             placeholder="Search language..."
                             value={langSearch}
                             onChange={(e) => setLangSearch(e.target.value)}
                             className="w-full bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 text-xs focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                           />
                         </div>
                       </div>
                       
                       <div className="max-h-60 overflow-y-auto custom-scrollbar">
                         {INDIAN_LANGUAGES.filter(l => 
                           l.name.toLowerCase().includes(langSearch.toLowerCase())
                         ).map(lang => (
                           <button
                            key={lang.code}
                            onClick={() => {
                              setSelectedLang(lang);
                              setIsLangOpen(false);
                              setLangSearch("");
                            }}
                            className={`w-full text-left px-4 py-2.5 text-xs font-semibold transition-all flex items-center justify-between ${
                              selectedLang.code === lang.code 
                                ? 'text-indigo-600 bg-indigo-50/50' 
                                : 'text-slate-600 hover:bg-slate-50'
                            }`}
                           >
                             <span>{lang.name}</span>
                             {selectedLang.code === lang.code && <CheckCircle2 className="h-3 w-3" />}
                           </button>
                         ))}
                         {INDIAN_LANGUAGES.filter(l => 
                           l.name.toLowerCase().includes(langSearch.toLowerCase())
                         ).length === 0 && (
                           <div className="px-4 py-6 text-center text-slate-400">
                             <p className="text-[10px] font-bold uppercase">No results</p>
                           </div>
                         )}
                       </div>
                     </motion.div>
                   </>
                 )}
               </AnimatePresence>
             </div>
             {/* User Profile / Logout */}
             <button
                onClick={handleLogout}
                className="rounded-full p-2 hover:bg-rose-50 transition-colors text-slate-400 hover:text-rose-500"
                title="Logout"
              >
                <LogOut className="h-5 w-5" />
              </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-lg pb-24 pt-20 px-4">
        <AnimatePresence mode="wait">
          {view === "picker" ? (
            <motion.div
              key="picker"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="space-y-2">
                <h2 className="text-2xl font-bold">Product Check</h2>
                <p className="text-slate-500">Scan or upload a fruit/vegetable to check its delivery quality.</p>
              </div>

              <div className="relative aspect-square w-full overflow-hidden rounded-3xl border-2 border-dashed border-slate-200 bg-white group hover:border-indigo-300 transition-colors">
                {preview ? (
                  <img src={preview} alt="Preview" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-4 text-slate-400">
                    <Camera className="h-12 w-12" />
                    <p className="text-sm font-medium">Capture or Select Image</p>
                  </div>
                )}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handleImageUpload}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </div>

              {/* Ad Slot Placeholder */}
              <div className="w-full bg-slate-100 rounded-2xl p-4 text-center border border-slate-200">
                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mb-1">Advertisement</p>
                <div className="h-16 bg-slate-200/50 rounded flex items-center justify-center italic text-slate-400 text-xs">
                  Space for AdSense Banner
                </div>
              </div>

              {loading && (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
                  <p className="text-sm font-medium text-slate-500 animate-pulse">Analyzing quality with AI...</p>
                </div>
              )}

              {result && !loading && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={`rounded-3xl p-6 text-white shadow-xl ${
                    result.quality === "GOOD" ? "bg-emerald-500" : "bg-rose-500"
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium uppercase tracking-wider opacity-80">Final Result</p>
                      <h3 className="text-4xl font-black">{result.quality}</h3>
                    </div>
                    <div className="rounded-2xl bg-white/20 p-2">
                      {result.quality === "GOOD" ? (
                        <CheckCircle2 className="h-10 w-10" />
                      ) : (
                        <XCircle className="h-10 w-10" />
                      )}
                    </div>
                  </div>

                  <div className="mt-8 grid grid-cols-2 gap-4">
                    <div className="rounded-2xl bg-white/10 p-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">Score</p>
                      <p className="text-2xl font-bold">{result.score}/100</p>
                    </div>
                    <div className="rounded-2xl bg-white/10 p-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">Reason</p>
                      <p className="text-xs font-medium leading-tight">{result.reason}</p>
                    </div>
                  </div>
                </motion.div>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              <div className="space-y-2">
                <h2 className="text-2xl font-bold">Warehouse Stats</h2>
                <p className="text-slate-500">Live overview of quality checks and delivery readiness.</p>
              </div>

              {/* Main Visual Stats */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Earnings Card */}
                <div className="rounded-3xl bg-gradient-to-br from-indigo-900 to-indigo-700 p-6 shadow-xl text-white relative overflow-hidden">
                  <div className="absolute -right-4 -top-4 w-24 h-24 bg-white/10 rounded-full blur-2xl" />
                  <div className="flex items-center justify-between mb-4 relative z-10">
                    <div className="flex flex-col">
                      <p className="text-[10px] font-bold uppercase tracking-widest opacity-80">Revenue Performance</p>
                      <p className="text-[8px] text-indigo-300 font-medium">Google AdSense Integration</p>
                    </div>
                    <div className="bg-green-400/20 text-green-300 text-[8px] font-bold px-2 py-0.5 rounded-full border border-green-400/30">
                      CONNECTED
                    </div>
                  </div>
                  <div className="space-y-1 relative z-10">
                    <div className="flex items-baseline gap-1">
                      <span className="text-sm opacity-70">₹</span>
                      <p className="text-4xl font-black tracking-tight">{stats ? (stats.total * 0.45).toFixed(2) : "0.00"}</p>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                       <p className="text-[10px] text-green-300 font-bold flex items-center gap-1">
                         <TrendingUp className="h-2.5 w-2.5" />
                         +12.4%
                       </p>
                       <p className="text-[9px] opacity-60 font-medium">vs last 24h</p>
                    </div>
                  </div>
                  <div className="mt-6 grid grid-cols-2 gap-2 relative z-10">
                    <button className="text-[9px] font-bold uppercase tracking-widest bg-white/10 hover:bg-white/20 transition-all py-2.5 px-3 rounded-xl border border-white/10">
                      View Ads
                    </button>
                    <button className="text-[9px] font-bold uppercase tracking-widest bg-indigo-500 hover:bg-indigo-400 transition-all py-2.5 px-3 rounded-xl shadow-lg flex items-center justify-center gap-1.5">
                      <Globe className="h-2.5 w-2.5" />
                      Publish
                    </button>
                  </div>
                </div>

                {/* Average Score Progress Ring */}
                <div className="rounded-3xl bg-white p-6 shadow-sm border border-slate-100 flex items-center justify-between">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Avg Quality</p>
                    <p className="text-3xl font-black text-slate-900">{stats ? Math.round(stats.avgScore || 0) : 0}%</p>
                    <p className="text-[10px] text-slate-400 font-medium">System Score</p>
                  </div>
                  <div className="relative h-20 w-20">
                    <svg className="h-full w-full" viewBox="0 0 36 36">
                      <path
                        className="text-slate-100 stroke-current"
                        strokeWidth="3"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                      <path
                        className="text-indigo-600 stroke-current transition-all duration-1000 ease-out"
                        strokeWidth="3"
                        strokeDasharray={`${stats ? stats.avgScore : 0}, 100`}
                        strokeLinecap="round"
                        fill="none"
                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <TrendingUp className="h-5 w-5 text-indigo-600" />
                    </div>
                  </div>
                </div>

                {/* Good vs Bad Breakdown */}
                <div className="rounded-3xl bg-white p-6 shadow-sm border border-slate-100">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Quality Split</p>
                    <PieChartIcon className="h-4 w-4 text-slate-300" />
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="h-24 w-24">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Tooltip 
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                return (
                                  <div className="bg-white p-2 border border-slate-100 rounded-lg shadow-xl text-[10px] font-bold">
                                    <p className="text-slate-500 uppercase">{payload[0].name}</p>
                                    <p style={{ color: payload[0].payload.fill || payload[0].color }}>
                                      {payload[0].value} Items
                                    </p>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                          <Pie
                            data={[
                              { name: 'Good', value: stats?.goodCount || 0, fill: COLORS[0] },
                              { name: 'Bad', value: stats?.badCount || 0, fill: COLORS[1] },
                            ]}
                            innerRadius={28}
                            outerRadius={42}
                            paddingAngle={8}
                            dataKey="value"
                            stroke="none"
                          >
                            {/* Cells are already colored via the data fill property or Cell components */}
                            <Cell key="cell-0" fill={COLORS[0]} />
                            <Cell key="cell-1" fill={COLORS[1]} />
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex-1 space-y-2">
                       <div className="flex items-center justify-between">
                         <span className="text-[10px] font-bold text-slate-400">GOOD</span>
                         <span className="text-[10px] font-bold text-emerald-600">
                           {stats?.total ? Math.round((stats.goodCount / stats.total) * 100) : 0}%
                         </span>
                       </div>
                       <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                         <div 
                           className="h-full bg-emerald-500 transition-all duration-1000" 
                           style={{ width: `${stats?.total ? (stats.goodCount / stats.total) * 100 : 0}%` }}
                         />
                       </div>
                       <div className="flex items-center justify-between mt-2">
                         <span className="text-[10px] font-bold text-slate-400">BAD</span>
                         <span className="text-[10px] font-bold text-rose-600">
                           {stats?.total ? Math.round((stats.badCount / stats.total) * 100) : 0}%
                         </span>
                       </div>
                       <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                         <div 
                           className="h-full bg-rose-500 transition-all duration-1000" 
                           style={{ width: `${stats?.total ? (stats.badCount / stats.total) * 100 : 0}%` }}
                         />
                       </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Summary Bar */}
              <div className="rounded-2xl bg-indigo-50 p-4 flex items-center justify-between border border-indigo-100">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-white flex items-center justify-center text-indigo-600 shadow-sm">
                    <Info size={18} />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-indigo-900 leading-none">Status Report</p>
                    <p className="text-[10px] text-indigo-600 font-medium">Total Items Checked: {stats?.total || 0}</p>
                  </div>
                </div>
                <ArrowRight className="h-4 w-4 text-indigo-300" />
              </div>

              {/* Modern Quality Trend Chart */}
              <div className="rounded-3xl bg-white p-6 shadow-sm border border-slate-100">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 leading-none">Quality Trends</h3>
                    <p className="text-[10px] text-slate-400 mt-1 uppercase font-bold tracking-widest">Last 10 Checks Performance</p>
                  </div>
                  <TrendingUp className="h-4 w-4 text-indigo-200" />
                </div>
                <div className="h-32 w-full">
                   <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={history.slice(0, 10).reverse().map((item, index) => ({
                          name: index + 1,
                          score: item.score
                        }))}
                      >
                        <defs>
                          <linearGradient id="colorScore" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                            <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <Tooltip 
                          content={({ active, payload }) => {
                            if (active && payload && payload.length) {
                              return (
                                <div className="bg-slate-900 text-white p-2 rounded-lg shadow-xl text-[10px] font-bold border border-slate-800">
                                  Score: {payload[0].value}%
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Area 
                          type="monotone" 
                          dataKey="score" 
                          stroke="#6366f1" 
                          strokeWidth={2}
                          fillOpacity={1} 
                          fill="url(#colorScore)" 
                        />
                      </AreaChart>
                   </ResponsiveContainer>
                </div>
              </div>

              {/* Feed Area */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Recent Checks</h3>
                  <HistoryIcon className="h-4 w-4 text-slate-400" />
                </div>
                <div className="space-y-3">
                  {history.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm border border-slate-100 group hover:border-indigo-200 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${
                          item.quality === 'GOOD' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'
                        }`}>
                          {item.quality === 'GOOD' ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
                        </div>
                        <div>
                          <p className="text-sm font-bold">Item {item.imageName}</p>
                          <p className="text-[10px] text-slate-400 font-medium">
                            {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-bold ${
                          item.quality === 'GOOD' ? 'text-emerald-600' : 'text-rose-600'
                        }`}>{item.score}%</p>
                        <p className="text-[10px] text-slate-400">Score</p>
                      </div>
                    </div>
                  ))}
                  {history.length === 0 && (
                    <div className="py-20 text-center space-y-2 opacity-50">
                      <Warehouse className="mx-auto h-12 w-12 text-slate-300" />
                      <p className="text-sm font-medium">No checks performed today.</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Navigation Footer */}
      <footer className="fixed bottom-0 z-50 w-full border-t border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto grid h-20 max-w-lg grid-cols-2 items-center">
          <button
            onClick={() => setView("picker")}
            className={`flex flex-col items-center gap-1 transition-colors ${
              view === "picker" ? "text-indigo-600" : "text-slate-400"
            }`}
          >
            <Camera size={24} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Picker</span>
          </button>
          <button
            onClick={() => setView("dashboard")}
            className={`flex flex-col items-center gap-1 transition-colors ${
              view === "dashboard" ? "text-indigo-600" : "text-slate-400"
            }`}
          >
            <LayoutDashboard size={24} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Dash</span>
          </button>
        </div>
      </footer>
    </div>
  );
}
