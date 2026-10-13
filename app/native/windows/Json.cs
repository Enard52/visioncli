using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VcliWin
{
    // A small JSON reader/writer: the helper may only use what ships with Windows, and the protocol is tiny.
    // Objects parse to Dictionary<string, object>, arrays to List<object>, numbers to double.
    static class Json
    {
        public static object Parse(string s)
        {
            int i = 0;
            var v = Value(s, ref i);
            Ws(s, ref i);
            if (i != s.Length) throw new FormatException("trailing characters in JSON");
            return v;
        }

        static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }

        static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) throw new FormatException("unexpected end of JSON");
            char c = s[i];
            if (c == '{')
            {
                var o = new Dictionary<string, object>();
                i++; Ws(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return o; }
                while (true)
                {
                    Ws(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new FormatException("expected key");
                    var k = Str(s, ref i);
                    Ws(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("expected ':'");
                    i++;
                    o[k] = Value(s, ref i);
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return o; }
                    throw new FormatException("expected ',' or '}'");
                }
            }
            if (c == '[')
            {
                var a = new List<object>();
                i++; Ws(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return a; }
                while (true)
                {
                    a.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return a; }
                    throw new FormatException("expected ',' or ']'");
                }
            }
            if (c == '"') return Str(s, ref i);
            if (Lit(s, ref i, "true")) return true;
            if (Lit(s, ref i, "false")) return false;
            if (Lit(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i) throw new FormatException("unexpected character '" + c + "'");
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static bool Lit(string s, ref int i, string lit)
        {
            if (string.CompareOrdinal(s, i, lit, 0, lit.Length) != 0) return false;
            i += lit.Length;
            return true;
        }

        static string Str(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("bad \\u escape");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: sb.Append(e); break;
                }
            }
            throw new FormatException("unterminated string");
        }

        public static string Write(object v)
        {
            var sb = new StringBuilder();
            Write(sb, v);
            return sb.ToString();
        }

        public static void Write(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null: sb.Append("null"); return;
                case string s: Quote(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case double d:
                    if (double.IsNaN(d) || double.IsInfinity(d)) sb.Append("null");
                    else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
                    return;
                case float f: Write(sb, (double)f); return;
                case int _: case long _: case uint _: case short _: case ushort _: case byte _: case ulong _:
                    sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture)); return;
                case IDictionary<string, object> o:
                    {
                        sb.Append('{');
                        bool first = true;
                        foreach (var kv in o)
                        {
                            if (!first) sb.Append(',');
                            first = false;
                            Quote(sb, kv.Key);
                            sb.Append(':');
                            Write(sb, kv.Value);
                        }
                        sb.Append('}');
                        return;
                    }
                case IEnumerable a:
                    {
                        sb.Append('[');
                        bool first = true;
                        foreach (var x in a)
                        {
                            if (!first) sb.Append(',');
                            first = false;
                            Write(sb, x);
                        }
                        sb.Append(']');
                        return;
                    }
                default: Quote(sb, v.ToString()); return;
            }
        }

        public static void Quote(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        // Control characters and line/paragraph separators are escaped so a line stays one line.
                        if (c < 0x20 || c == '\u2028' || c == '\u2029') sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>Builds an object from key/value pairs: Json.O("x", 1, "y", 2).</summary>
        public static Dictionary<string, object> O(params object[] kv)
        {
            var o = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) o[(string)kv[i]] = kv[i + 1];
            return o;
        }
    }

    /// <summary>Typed access to a request's params.</summary>
    sealed class Args
    {
        readonly Dictionary<string, object> o;
        public Args(object p) { o = p as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        public bool Has(string k) => o.TryGetValue(k, out var v) && v != null;
        public string Str(string k, string def = null) => o.TryGetValue(k, out var v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : def;
        public double Num(string k, double def = 0) => o.TryGetValue(k, out var v) && v is double d ? d : def;
        public int Int(string k, int def = 0) => Has(k) ? (int)Math.Round(Num(k, def)) : def;
        public bool Bool(string k, bool def = false) => o.TryGetValue(k, out var v) && v is bool b ? b : def;
        public string Need(string k) => Str(k) ?? throw new ArgumentException("missing param '" + k + "'");
        public Args Obj(string k) => o.TryGetValue(k, out var v) && v is Dictionary<string, object> d ? new Args(d) : null;
        public List<string> Strs(string k)
        {
            if (!o.TryGetValue(k, out var v) || !(v is List<object> a)) return null;
            var r = new List<string>();
            foreach (var x in a) if (x != null) r.Add(Convert.ToString(x, CultureInfo.InvariantCulture));
            return r;
        }
    }
}
