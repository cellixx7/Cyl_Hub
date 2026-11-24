// Motor WASAPI do CYL Audio Hub.
// Baseado no AudioEngine.cs do Zeus Pro Suite (MIT, Copyright (c) 2026 Rodrigo) — ver
// THIRD_PARTY_NOTICES.md. Acrescentado para o CYL Audio Hub: modo "serve" persistente (um
// processo, comandos por linha no stdin, uma resposta JSON por linha no stdout), saída UTF-8,
// "procs" (nomes dos processos em execução, para a troca automática de perfil) e "default" com
// papéis selecionáveis. Somente APIs públicas do Windows (MMDevice / EndpointVolume /
// AudioSessions / IPolicyConfig); nada é injetado em outros processos.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

namespace ZeusPro
{
    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            try
            {
                if (args.Length > 0 && args[0] == "serve") return Serve();
                if (args.Length == 0)
                {
                    Console.WriteLine("{\"ok\":false,\"error\":\"uso: list | status | volume <id> <0-100> | mute <id> <0|1> | default <id> | sessions | session-volume <pid> <0-100> | peaks\"}");
                    return 1;
                }
                if (args[0].ToLowerInvariant() == "ping")
                {
                    using (var mm = new MM())
                    {
                        Console.WriteLine(J.Obj(new Kv("ok", true), new Kv("ping", mm.Ping())));
                    }
                    return 0;
                }
                using (var mm = new MM())
                {
                    switch (args[0].ToLowerInvariant())
                    {
                        case "list":
                            Console.WriteLine(J.Obj(new Kv("ok", true), new Kv("devices", mm.List())));
                            return 0;
                        case "status":
                            Console.WriteLine(J.Obj(new Kv("ok", true), new Kv("status", mm.Status())));
                            return 0;
                        case "volume":
                            mm.SetVolume(args[1], C(F(args[2]) / 100f));
                            Console.WriteLine(J.Obj(new Kv("ok", true)));
                            return 0;
                        case "mute":
                            mm.SetMute(args[1], args[2] == "1" || args[2].Equals("true", StringComparison.OrdinalIgnoreCase));
                            Console.WriteLine(J.Obj(new Kv("ok", true)));
                            return 0;
                        case "default":
                            mm.SetDefault(args[1]);
                            Console.WriteLine(J.Obj(new Kv("ok", true)));
                            return 0;
                        case "sessions":
                            Console.WriteLine(J.Obj(new Kv("ok", true), new Kv("sessions", mm.Sessions())));
                            return 0;
                        case "session-volume":
                            mm.SetSessionVolume(int.Parse(args[1], CultureInfo.InvariantCulture), C(F(args[2]) / 100f));
                            Console.WriteLine(J.Obj(new Kv("ok", true)));
                            return 0;
                        case "peaks":
                            Console.WriteLine(J.Obj(new Kv("ok", true), new Kv("peaks", mm.Peaks())));
                            return 0;
                        default:
                            Console.WriteLine(J.Obj(new Kv("ok", false), new Kv("error", "comando desconhecido")));
                            return 1;
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine(J.Obj(new Kv("ok", false), new Kv("error", ex.Message)));
                return 1;
            }
        }

        // Persistent mode: "<id>\t<cmd>\t<arg>..." per line in, {"id":..,"ok":..} per line out.
        // Ends when stdin closes, so the engine never outlives the app that started it.
        static int Serve()
        {
            Console.InputEncoding = new UTF8Encoding(false);
            using (var mm = new MM())
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    var p = line.Split('\t');
                    var res = new Map().Add("id", p[0]);
                    try
                    {
                        Dispatch(mm, p, res);
                        res.Add("ok", true);
                    }
                    catch (Exception ex)
                    {
                        res.Add("ok", false).Add("error", ex.Message);
                    }
                    Console.Out.WriteLine(res.ToString());
                    Console.Out.Flush();
                }
            }
            return 0;
        }

        static string Arg(string[] p, int i)
        {
            if (p.Length <= i) throw new ArgumentException("argumento ausente");
            return p[i];
        }

        static void Dispatch(MM mm, string[] p, Map res)
        {
            string cmd = p.Length > 1 ? p[1] : "";
            switch (cmd)
            {
                case "ping": res.Add("pong", true); return;
                case "status": res.Add("status", mm.Status()); return;
                case "list": res.Add("devices", mm.List()); return;
                case "peaks": res.Add("peaks", mm.Peaks()); return;
                case "sessions": res.Add("sessions", mm.Sessions()); return;
                case "volume": mm.SetVolume(Arg(p, 2), C(F(Arg(p, 3)) / 100f)); return;
                case "mute": mm.SetMute(Arg(p, 2), Arg(p, 3) == "1"); return;
                case "default": mm.SetDefault(Arg(p, 2), p.Length > 3 ? p[3] : "all"); return;
                case "procs": res.Add("procs", Procs()); return;
                default: throw new ArgumentException("comando desconhecido: " + cmd);
            }
        }

        // Distinct lower-case image names of running processes (no paths, no command lines).
        static Arr Procs()
        {
            var seen = new HashSet<string>();
            var arr = new Arr();
            foreach (var pr in Process.GetProcesses())
            {
                try
                {
                    string n = pr.ProcessName.ToLowerInvariant();
                    if (seen.Add(n)) arr.Add(n);
                }
                catch { }
                finally { pr.Dispose(); }
            }
            return arr;
        }

        static float F(string s) { return float.Parse(s, CultureInfo.InvariantCulture); }
        static float C(float v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
    }

    static class Native
    {
        [DllImport("ole32.dll")]
        public static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint ctx, ref Guid iid, out IntPtr ppv);

        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PROPVARIANT pvar);

        public static IntPtr Slot(IntPtr obj, int index)
        {
            IntPtr vtbl = Marshal.ReadIntPtr(obj);
            return Marshal.ReadIntPtr(vtbl, index * IntPtr.Size);
        }

        public static void Check(int hr, string op)
        {
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        }

        public static T Fn<T>(IntPtr obj, int slot) where T : class
        {
            return (T)(object)Marshal.GetDelegateForFunctionPointer(Slot(obj, slot), typeof(T));
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrQI(IntPtr self, ref Guid iid, out IntPtr ppv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate uint HrAddRef(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate uint HrRelease(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrEnum(IntPtr self, int flow, int mask, out IntPtr col);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrGetDef(IntPtr self, int flow, int role, out IntPtr dev);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrGetDev(IntPtr self, [MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr dev);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrCount(IntPtr self, out uint n);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrItem(IntPtr self, uint i, out IntPtr dev);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrActivate(IntPtr self, ref Guid iid, int ctx, IntPtr act, out IntPtr ppv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrOpenStore(IntPtr self, int access, out IntPtr store);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrGetId(IntPtr self, out IntPtr str);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrGetValue(IntPtr self, ref PROPERTYKEY key, out PROPVARIANT pv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrVolScalarGet(IntPtr self, out float v);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrVolScalarSet(IntPtr self, float v, ref Guid ctx);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrMuteGet(IntPtr self, out int mute);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrMuteSet(IntPtr self, int mute, ref Guid ctx);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrPeak(IntPtr self, out float peak);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrSessEnum(IntPtr self, out IntPtr en);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrSessCount(IntPtr self, out int n);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrSessItem(IntPtr self, int i, out IntPtr ctl);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrPid(IntPtr self, out int pid);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrDisp(IntPtr self, out IntPtr name);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrSVolGet(IntPtr self, out float v);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrSVolSet(IntPtr self, float v, ref Guid ctx);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrSMuteGet(IntPtr self, out int m);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int HrSetDefault(IntPtr self, [MarshalAs(UnmanagedType.LPWStr)] string id, int role);

    sealed class MM : IDisposable
    {
        static readonly Guid CLSID_Enum = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        static readonly Guid IID_Enum = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
        static readonly Guid IID_Volume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static readonly Guid IID_Meter = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
        static readonly Guid IID_SessMgr2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        static readonly Guid CLSID_Policy = new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9");
        static readonly Guid IID_Policy = new Guid("F8679F50-850A-41CF-9C72-430F290290C8");
        static readonly Guid IID_SessCtl2 = new Guid("BFB7FF88-7239-4FC9-8FA2-07B679D62D13");
        static readonly Guid IID_SimpleVol = new Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8");

        readonly IntPtr _enum;

        public MM()
        {
            Guid c = CLSID_Enum, i = IID_Enum;
            Native.Check(Native.CoCreateInstance(ref c, IntPtr.Zero, 1, ref i, out _enum), "CoCreate enumerator");
        }

        public void Dispose()
        {
            if (_enum != IntPtr.Zero) Native.Fn<HrRelease>(_enum, 2)(_enum);
        }

        public string Ping()
        {
            IntPtr r;
            Native.Check(Native.Fn<HrGetDef>(_enum, 4)(_enum, 0, 1, out r), "default render");
            try
            {
                IntPtr pId;
                Native.Check(Native.Fn<HrGetId>(r, 5)(r, out pId), "GetId");
                string id = Marshal.PtrToStringUni(pId) ?? "";
                Marshal.FreeCoTaskMem(pId);
                string name = Prop(r, Pkey.FriendlyName);
                return name + " | " + id;
            }
            finally { Native.Fn<HrRelease>(r, 2)(r); }
        }

        public Arr List()
        {
            var arr = new Arr();
            AddFlow(arr, 0);
            AddFlow(arr, 1);
            return arr;
        }

        void AddFlow(Arr arr, int flow)
        {
            IntPtr col;
            Native.Check(Native.Fn<HrEnum>(_enum, 3)(_enum, flow, 1, out col), "EnumAudioEndpoints");
            try
            {
                uint n;
                Native.Check(Native.Fn<HrCount>(col, 3)(col, out n), "GetCount");
                for (uint i = 0; i < n; i++)
                {
                    IntPtr dev;
                    Native.Check(Native.Fn<HrItem>(col, 4)(col, i, out dev), "Item");
                    try { arr.Add(DeviceJson(dev, flow)); }
                    finally { Native.Fn<HrRelease>(dev, 2)(dev); }
                }
            }
            finally { Native.Fn<HrRelease>(col, 2)(col); }
        }

        public Map Status()
        {
            var devices = List();
            return new Map()
                .Add("devices", devices)
                .Add("defaultRender", Default(0, 1))
                .Add("defaultCapture", Default(1, 1))
                .Add("defaultCommCapture", Default(1, 2))
                .Add("zeus", MatchZeus(devices));
        }

        // A PC with no microphone (or no output) has no default endpoint: report null, don't fail.
        object Default(int flow, int role)
        {
            IntPtr d;
            if (Native.Fn<HrGetDef>(_enum, 4)(_enum, flow, role, out d) < 0 || d == IntPtr.Zero) return J.Null;
            try { return DeviceJson(d, flow); }
            finally { Native.Fn<HrRelease>(d, 2)(d); }
        }

        Map DeviceJson(IntPtr dev, int flow)
        {
            IntPtr pId;
            Native.Check(Native.Fn<HrGetId>(dev, 5)(dev, out pId), "GetId");
            string id = Marshal.PtrToStringUni(pId) ?? "";
            Marshal.FreeCoTaskMem(pId);
            string name = Prop(dev, Pkey.FriendlyName);
            string desc = Prop(dev, Pkey.DeviceDesc);
            string iface = Prop(dev, Pkey.InterfaceFriendly);
            float vol; bool mute; float peak;
            TryVolume(dev, out vol, out mute);
            TryPeak(dev, out peak);
            bool zeus = IsZeus(id, name, desc, iface);
            return new Map()
                .Add("id", id)
                .Add("name", name)
                .Add("description", desc)
                .Add("interface", iface)
                .Add("flow", flow == 0 ? "render" : "capture")
                .Add("volume", Math.Round(vol * 100, 1))
                .Add("mute", mute)
                .Add("peak", Math.Round(peak, 4))
                .Add("zeus", zeus)
                .Add("mode", InferMode(id, name, iface));
        }

        static bool IsZeus(string id, string name, string desc, string iface)
        {
            string blob = ((id ?? "") + " " + (name ?? "") + " " + (desc ?? "") + " " + (iface ?? "")).ToUpperInvariant();
            if (blob.Contains("VID_040B") && blob.Contains("PID_0897")) return true;
            if (blob.Contains("040B") && blob.Contains("0897")) return true;
            if (blob.Contains("XIISOUND")) return true;
            if (blob.Contains("H510") || blob.Contains("ZEUS")) return true;
            if (blob.Contains("REDRAGON") && (blob.Contains("HEAD") || blob.Contains("HEADSET") || blob.Contains("MIC"))) return true;
            return false;
        }

        static string InferMode(string id, string name, string iface)
        {
            string blob = ((id ?? "") + " " + (name ?? "") + " " + (iface ?? "")).ToUpperInvariant();
            if (blob.Contains("BTHENUM") || blob.Contains("BLUETOOTH") || blob.Contains("BTHHFENUM")) return "bluetooth";
            if (blob.Contains("H510") || blob.Contains("VID_040B") || blob.Contains("PID_0897") || blob.Contains("XIISOUND") || blob.Contains("WIRELESS HEADSET")) return "24ghz";
            if (blob.Contains("USB") || blob.Contains("USBAUDIO")) return "usb";
            return "unknown";
        }

        Map MatchZeus(Arr devices)
        {
            Map render = null, capture = null;
            foreach (var item in devices.Items)
            {
                var m = (Map)item;
                if (!m.Bool("zeus")) continue;
                if (m.Str("flow") == "render" && render == null) render = m;
                if (m.Str("flow") == "capture" && capture == null) capture = m;
            }
            return new Map()
                .Add("connected", render != null || capture != null)
                .Add("render", (object)render ?? J.Null)
                .Add("capture", (object)capture ?? J.Null);
        }

        public void SetVolume(string id, float level)
        {
            IntPtr dev = GetDevice(id);
            try
            {
                IntPtr vol = Activate(dev, IID_Volume);
                try
                {
                    Guid g = Guid.Empty;
                    Native.Check(Native.Fn<HrVolScalarSet>(vol, 7)(vol, level, ref g), "SetVolume");
                }
                finally { Native.Fn<HrRelease>(vol, 2)(vol); }
            }
            finally { Native.Fn<HrRelease>(dev, 2)(dev); }
        }

        public void SetMute(string id, bool mute)
        {
            IntPtr dev = GetDevice(id);
            try
            {
                IntPtr vol = Activate(dev, IID_Volume);
                try
                {
                    Guid g = Guid.Empty;
                    Native.Check(Native.Fn<HrMuteSet>(vol, 14)(vol, mute ? 1 : 0, ref g), "SetMute");
                }
                finally { Native.Fn<HrRelease>(vol, 2)(vol); }
            }
            finally { Native.Fn<HrRelease>(dev, 2)(dev); }
        }

        // roles: "all" (console + multimedia + communications), "comm" (communications only),
        // "media" (console + multimedia only).
        public void SetDefault(string id, string roles = "all")
        {
            Guid c = CLSID_Policy, i = IID_Policy;
            IntPtr cfg;
            Native.Check(Native.CoCreateInstance(ref c, IntPtr.Zero, 1, ref i, out cfg), "PolicyConfig");
            try
            {
                var fn = Native.Fn<HrSetDefault>(cfg, 13);
                if (roles != "comm")
                {
                    Native.Check(fn(cfg, id, 0), "default console");
                    Native.Check(fn(cfg, id, 1), "default multimedia");
                }
                if (roles != "media") Native.Check(fn(cfg, id, 2), "default comm");
            }
            finally { Native.Fn<HrRelease>(cfg, 2)(cfg); }
        }

        public Arr Sessions()
        {
            try
            {
                IntPtr dev;
                Native.Check(Native.Fn<HrGetDef>(_enum, 4)(_enum, 0, 1, out dev), "default render");
                try { return SessionsOf(dev); }
                finally { Native.Fn<HrRelease>(dev, 2)(dev); }
            }
            catch
            {
                return new Arr();
            }
        }

        Arr SessionsOf(IntPtr dev)
        {
            var arr = new Arr();
            IntPtr mgr = Activate(dev, IID_SessMgr2);
            try
            {
                IntPtr en;
                Native.Check(Native.Fn<HrSessEnum>(mgr, 5)(mgr, out en), "GetSessionEnumerator");
                try
                {
                    int count;
                    Native.Check(Native.Fn<HrSessCount>(en, 3)(en, out count), "session count");
                    for (int i = 0; i < count; i++)
                    {
                        IntPtr ctl = IntPtr.Zero;
                        if (Native.Fn<HrSessItem>(en, 4)(en, i, out ctl) < 0 || ctl == IntPtr.Zero) continue;
                        try
                        {
                            IntPtr ctl2 = Qi(ctl, IID_SessCtl2);
                            int pid = 0;
                            try { Native.Fn<HrPid>(ctl2, 14)(ctl2, out pid); }
                            finally { Native.Fn<HrRelease>(ctl2, 2)(ctl2); }
                            IntPtr pName;
                            Native.Fn<HrDisp>(ctl, 4)(ctl, out pName);
                            string dn = pName == IntPtr.Zero ? "" : (Marshal.PtrToStringUni(pName) ?? "");
                            if (pName != IntPtr.Zero) Marshal.FreeCoTaskMem(pName);
                            string proc = "";
                            try { if (pid > 0) proc = Process.GetProcessById(pid).ProcessName; } catch { }
                            IntPtr svol = Qi(ctl, IID_SimpleVol);
                            float v = 0; int mute = 0;
                            try
                            {
                                Native.Fn<HrSVolGet>(svol, 4)(svol, out v);
                                Native.Fn<HrSMuteGet>(svol, 6)(svol, out mute);
                            }
                            finally { Native.Fn<HrRelease>(svol, 2)(svol); }
                            arr.Add(new Map()
                                .Add("pid", pid)
                                .Add("process", proc)
                                .Add("name", string.IsNullOrWhiteSpace(dn) ? proc : dn)
                                .Add("volume", Math.Round(v * 100, 1))
                                .Add("mute", mute != 0));
                        }
                        catch { }
                        finally { if (ctl != IntPtr.Zero) Native.Fn<HrRelease>(ctl, 2)(ctl); }
                    }
                }
                finally { Native.Fn<HrRelease>(en, 2)(en); }
            }
            finally { Native.Fn<HrRelease>(mgr, 2)(mgr); }
            return arr;
        }

        public void SetSessionVolume(int pid, float level)
        {
            IntPtr dev;
            Native.Check(Native.Fn<HrGetDef>(_enum, 4)(_enum, 0, 1, out dev), "default render");
            try
            {
                IntPtr mgr = Activate(dev, IID_SessMgr2);
                try
                {
                    IntPtr en;
                    Native.Check(Native.Fn<HrSessEnum>(mgr, 5)(mgr, out en), "enum");
                    try
                    {
                        int count; Native.Fn<HrSessCount>(en, 3)(en, out count);
                        bool found = false;
                        for (int i = 0; i < count; i++)
                        {
                            IntPtr ctl; Native.Fn<HrSessItem>(en, 4)(en, i, out ctl);
                            try
                            {
                                IntPtr ctl2 = Qi(ctl, IID_SessCtl2);
                                int p = 0;
                                try { Native.Fn<HrPid>(ctl2, 14)(ctl2, out p); }
                                finally { Native.Fn<HrRelease>(ctl2, 2)(ctl2); }
                                if (p == pid)
                                {
                                    IntPtr svol = Qi(ctl, IID_SimpleVol);
                                    try
                                    {
                                        Guid g = Guid.Empty;
                                        Native.Check(Native.Fn<HrSVolSet>(svol, 3)(svol, level, ref g), "session volume");
                                        found = true;
                                    }
                                    finally { Native.Fn<HrRelease>(svol, 2)(svol); }
                                }
                            }
                            finally { Native.Fn<HrRelease>(ctl, 2)(ctl); }
                        }
                        if (!found) throw new Exception("sessão não encontrada: pid " + pid);
                    }
                    finally { Native.Fn<HrRelease>(en, 2)(en); }
                }
                finally { Native.Fn<HrRelease>(mgr, 2)(mgr); }
            }
            finally { Native.Fn<HrRelease>(dev, 2)(dev); }
        }

        public Arr Peaks()
        {
            var arr = new Arr();
            foreach (int flow in new[] { 0, 1 })
            {
                IntPtr col;
                Native.Check(Native.Fn<HrEnum>(_enum, 3)(_enum, flow, 1, out col), "enum");
                try
                {
                    uint n; Native.Fn<HrCount>(col, 3)(col, out n);
                    for (uint i = 0; i < n; i++)
                    {
                        IntPtr dev; Native.Fn<HrItem>(col, 4)(col, i, out dev);
                        try
                        {
                            IntPtr pId; Native.Fn<HrGetId>(dev, 5)(dev, out pId);
                            string id = Marshal.PtrToStringUni(pId) ?? "";
                            Marshal.FreeCoTaskMem(pId);
                            float peak; TryPeak(dev, out peak);
                            arr.Add(new Map().Add("id", id).Add("peak", Math.Round(peak, 4)).Add("flow", flow == 0 ? "render" : "capture"));
                        }
                        finally { Native.Fn<HrRelease>(dev, 2)(dev); }
                    }
                }
                finally { Native.Fn<HrRelease>(col, 2)(col); }
            }
            return arr;
        }

        IntPtr GetDevice(string id)
        {
            IntPtr dev;
            Native.Check(Native.Fn<HrGetDev>(_enum, 5)(_enum, id, out dev), "GetDevice");
            return dev;
        }

        IntPtr Activate(IntPtr dev, Guid iid)
        {
            Guid g = iid;
            IntPtr ppv;
            Native.Check(Native.Fn<HrActivate>(dev, 3)(dev, ref g, 23, IntPtr.Zero, out ppv), "Activate " + iid);
            return ppv;
        }

        static IntPtr Qi(IntPtr obj, Guid iid)
        {
            Guid g = iid;
            IntPtr p;
            Native.Check(Native.Fn<HrQI>(obj, 0)(obj, ref g, out p), "QI " + iid);
            return p;
        }

        void TryVolume(IntPtr dev, out float vol, out bool mute)
        {
            vol = 0; mute = false;
            try
            {
                IntPtr v = Activate(dev, IID_Volume);
                try
                {
                    Native.Fn<HrVolScalarGet>(v, 9)(v, out vol);
                    int m; Native.Fn<HrMuteGet>(v, 15)(v, out m);
                    mute = m != 0;
                }
                finally { Native.Fn<HrRelease>(v, 2)(v); }
            }
            catch { }
        }

        void TryPeak(IntPtr dev, out float peak)
        {
            peak = 0;
            try
            {
                IntPtr m = Activate(dev, IID_Meter);
                try { Native.Fn<HrPeak>(m, 3)(m, out peak); }
                finally { Native.Fn<HrRelease>(m, 2)(m); }
            }
            catch { }
        }

        string Prop(IntPtr dev, PROPERTYKEY key)
        {
            IntPtr store;
            if (Native.Fn<HrOpenStore>(dev, 4)(dev, 0, out store) < 0) return "";
            try
            {
                PROPVARIANT pv;
                if (Native.Fn<HrGetValue>(store, 5)(store, ref key, out pv) < 0) return "";
                try
                {
                    if (pv.vt == 31 || pv.vt == 8) return Marshal.PtrToStringUni(pv.ptr) ?? "";
                    return "";
                }
                finally { Native.PropVariantClear(ref pv); }
            }
            finally { Native.Fn<HrRelease>(store, 2)(store); }
        }
    }

    struct Kv { public string K; public object V; public Kv(string k, object v) { K = k; V = v; } }

    static class J
    {
        public static readonly object Null = new object();
        public static string Obj(params Kv[] kvs)
        {
            var m = new Map();
            foreach (var kv in kvs) m.Add(kv.K, kv.V);
            return m.ToString();
        }
        public static string Enc(object v)
        {
            if (v == null || ReferenceEquals(v, Null)) return "null";
            if (v is bool) return ((bool)v) ? "true" : "false";
            if (v is int || v is uint || v is long) return Convert.ToString(v, CultureInfo.InvariantCulture);
            if (v is float) return ((float)v).ToString("0.###", CultureInfo.InvariantCulture);
            if (v is double) return ((double)v).ToString("0.###", CultureInfo.InvariantCulture);
            if (v is Map || v is Arr) return v.ToString();
            return "\"" + Esc(Convert.ToString(v, CultureInfo.InvariantCulture) ?? "") + "\"";
        }
        static string Esc(string s)
        {
            var sb = new StringBuilder();
            foreach (char ch in s)
            {
                if (ch == '\\') sb.Append("\\\\");
                else if (ch == '"') sb.Append("\\\"");
                else if (ch == '\n') sb.Append("\\n");
                else if (ch < 32) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                else sb.Append(ch);
            }
            return sb.ToString();
        }
    }

    sealed class Map
    {
        readonly List<Kv> _kv = new List<Kv>();
        public Map Add(string k, object v) { _kv.Add(new Kv(k, v)); return this; }
        public bool Bool(string k) { foreach (var x in _kv) if (x.K == k && x.V is bool) return (bool)x.V; return false; }
        public string Str(string k) { foreach (var x in _kv) if (x.K == k) return Convert.ToString(x.V, CultureInfo.InvariantCulture); return ""; }
        public override string ToString()
        {
            var sb = new StringBuilder().Append('{');
            for (int i = 0; i < _kv.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(J.Enc(_kv[i].K)).Append(':').Append(J.Enc(_kv[i].V));
            }
            return sb.Append('}').ToString();
        }
    }

    sealed class Arr
    {
        public readonly List<object> Items = new List<object>();
        public void Add(object v) { Items.Add(v); }
        public override string ToString()
        {
            var sb = new StringBuilder().Append('[');
            for (int i = 0; i < Items.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(J.Enc(Items[i]));
            }
            return sb.Append(']').ToString();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr ptr;
    }

    static class Pkey
    {
        public static readonly PROPERTYKEY FriendlyName = Key("a45c254e-df1c-4efd-8020-67d146a850e0", 14);
        public static readonly PROPERTYKEY DeviceDesc = Key("a45c254e-df1c-4efd-8020-67d146a850e0", 2);
        public static readonly PROPERTYKEY InterfaceFriendly = Key("026e516e-b814-414b-83cd-856d6fef4822", 2);
        static PROPERTYKEY Key(string g, uint pid) { return new PROPERTYKEY { fmtid = new Guid(g), pid = pid }; }
    }
}
