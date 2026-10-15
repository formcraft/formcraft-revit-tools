using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace revit_mcp_plugin.Core
{
    /// <summary>
    /// F-031 (issue #123): turns the bytes of one connection into whole JSON-RPC messages.
    /// <para>The connection used to read once into an 8 KB buffer and parse that as the whole request, so a request over
    /// 8 KB (a 10 KB script, escaped) arrived in pieces, each piece failed to parse, the error had no id and the MCP server
    /// waited for an answer that never came. This reader keeps the bytes until a top-level JSON object (or array) closes,
    /// counting braces outside strings, and decodes UTF-8 across reads. Messages up to <see cref="MaxChars"/> are taken.</para>
    /// </summary>
    public sealed class JsonFrameReader
    {
        /// <summary>Largest message accepted (16 M characters); a bigger one closes the connection with FMC-BRIDGE-TOO-LARGE.</summary>
        public const int MaxChars = 16 * 1024 * 1024;

        private readonly Decoder _decoder = new UTF8Encoding(false).GetDecoder();
        private readonly StringBuilder _pending = new StringBuilder();
        private int _scanned;
        private int _depth;
        private bool _inString;
        private bool _escape;
        private int _start = -1;

        /// <summary>Characters received but not yet part of a whole message.</summary>
        public int Pending => _pending.Length;

        /// <summary>Adds bytes read from the socket; returns every message they complete (often none, sometimes several).</summary>
        public List<string> Feed(byte[] buffer, int count)
        {
            var messages = new List<string>();
            if (count <= 0) return messages;
            char[] chars = new char[_decoder.GetCharCount(buffer, 0, count)];
            int n = _decoder.GetChars(buffer, 0, count, chars, 0);
            _pending.Append(chars, 0, n);
            if (_pending.Length > MaxChars)
                throw new InvalidDataException($"FMC-BRIDGE-TOO-LARGE: a request over {MaxChars:N0} characters was refused.");

            int i = _scanned;
            while (i < _pending.Length)
            {
                char c = _pending[i];
                if (_start < 0)
                {
                    if (c == '{' || c == '[') { _start = i; _depth = 1; _inString = false; _escape = false; }
                    else if (!char.IsWhiteSpace(c) && c != '﻿')
                    {
                        // Not JSON at all: hand it on whole, so the caller answers with a parse error.
                        messages.Add(_pending.ToString(i, _pending.Length - i));
                        _pending.Clear();
                        i = 0;
                        break;
                    }
                    i++;
                    continue;
                }

                if (_inString)
                {
                    if (_escape) _escape = false;
                    else if (c == '\\') _escape = true;
                    else if (c == '"') _inString = false;
                }
                else if (c == '"') _inString = true;
                else if (c == '{' || c == '[') _depth++;
                else if (c == '}' || c == ']')
                {
                    _depth--;
                    if (_depth == 0)
                    {
                        messages.Add(_pending.ToString(_start, i - _start + 1));
                        _pending.Remove(0, i + 1);
                        _start = -1;
                        i = 0;
                        continue;
                    }
                }
                i++;
            }
            _scanned = Math.Min(i, _pending.Length);
            return messages;
        }
    }
}
