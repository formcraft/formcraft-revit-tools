using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Formcraft.Shell.Services
{
    /// <summary>
    /// Voice replies in Team › Review (PLAN_MARK_REVIEW R2): records the microphone as 16 kHz mono 16-bit WAV, the one
    /// format whisper.cpp reads, so a note goes straight to offline transcription with no converter.
    /// </summary>
    public interface IVoiceRecorder
    {
        bool IsRecording { get; }
        /// <summary>Why recording can't start on this PC (no microphone), or null.</summary>
        string? Problem();
        /// <summary>Starts recording; throws with a plain reason when the microphone can't be opened.</summary>
        void Start();
        /// <summary>Stops and writes the WAV to a temp file; returns its path (the caller deletes it once sent).</summary>
        string Stop();
        /// <summary>Stops and throws the recording away.</summary>
        void Discard();
        TimeSpan Elapsed { get; }
    }

    /// <summary>The 44-byte header of a PCM WAV file.</summary>
    public static class Wav
    {
        public const int Rate = 16000, Bits = 16, Channels = 1;

        public static byte[] Header(int dataBytes, int rate = Rate, int bits = Bits, int channels = Channels)
        {
            var h = new byte[44];
            void Text(int at, string s) { for (int i = 0; i < 4; i++) h[at + i] = (byte)s[i]; }
            void U32(int at, int v) => BitConverter.GetBytes(v).CopyTo(h, at);
            void U16(int at, int v) => BitConverter.GetBytes((ushort)v).CopyTo(h, at);
            Text(0, "RIFF"); U32(4, 36 + dataBytes); Text(8, "WAVE");
            Text(12, "fmt "); U32(16, 16); U16(20, 1); U16(22, channels); U32(24, rate);
            U32(28, rate * channels * bits / 8); U16(32, channels * bits / 8); U16(34, bits);
            Text(36, "data"); U32(40, dataBytes);
            return h;
        }

        public static string WriteTemp(byte[] pcm)
        {
            var path = Path.Combine(Path.GetTempPath(), "fmc-voice-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6) + ".wav");
            using (var f = File.Create(path))
            {
                var h = Header(pcm.Length);
                f.Write(h, 0, h.Length);
                f.Write(pcm, 0, pcm.Length);
            }
            return path;
        }
    }

    /// <summary>
    /// The microphone through WinMM's waveIn (in every Windows, no package): eight 100 ms buffers cycle through the driver;
    /// a background thread wakes on the driver's event, copies each finished buffer in order and gives it back.
    /// Five minutes at most (about 9.6 MB); after that it keeps the first five minutes.
    /// </summary>
    public sealed class WinMmVoiceRecorder : IVoiceRecorder
    {
        private const int WaveMapper = -1, CallbackEvent = 0x00050000, WhdrDone = 0x1, Buffers = 8, BufferBytes = 3200;
        public static readonly TimeSpan MaxLength = TimeSpan.FromMinutes(5);

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct WaveFormatEx
        {
            public ushort wFormatTag, nChannels;
            public uint nSamplesPerSec, nAvgBytesPerSec;
            public ushort nBlockAlign, wBitsPerSample, cbSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WaveHdr
        {
            public IntPtr lpData;
            public uint dwBufferLength, dwBytesRecorded;
            public IntPtr dwUser;
            public uint dwFlags, dwLoops;
            public IntPtr lpNext, reserved;
        }

        [DllImport("winmm.dll")] private static extern int waveInGetNumDevs();
        [DllImport("winmm.dll")] private static extern int waveInOpen(out IntPtr handle, int device, ref WaveFormatEx format, IntPtr callback, IntPtr instance, int flags);
        [DllImport("winmm.dll")] private static extern int waveInPrepareHeader(IntPtr handle, IntPtr header, int size);
        [DllImport("winmm.dll")] private static extern int waveInUnprepareHeader(IntPtr handle, IntPtr header, int size);
        [DllImport("winmm.dll")] private static extern int waveInAddBuffer(IntPtr handle, IntPtr header, int size);
        [DllImport("winmm.dll")] private static extern int waveInStart(IntPtr handle);
        [DllImport("winmm.dll")] private static extern int waveInStop(IntPtr handle);
        [DllImport("winmm.dll")] private static extern int waveInReset(IntPtr handle);
        [DllImport("winmm.dll")] private static extern int waveInClose(IntPtr handle);

        private static readonly int HdrSize = Marshal.SizeOf(typeof(WaveHdr));
        private readonly object _gate = new object();
        private readonly MemoryStream _pcm = new MemoryStream();
        private readonly Queue<int> _order = new Queue<int>();
        private IntPtr _handle = IntPtr.Zero;
        private IntPtr[] _headers = new IntPtr[0];
        private IntPtr[] _data = new IntPtr[0];
        private AutoResetEvent? _event;
        private Thread? _thread;
        private volatile bool _stopping;

        public bool IsRecording => _handle != IntPtr.Zero;
        public TimeSpan Elapsed { get { lock (_gate) return TimeSpan.FromSeconds(_pcm.Length / (double)(Wav.Rate * 2)); } }

        public string? Problem()
        {
            try { return waveInGetNumDevs() > 0 ? null : "No microphone found: plug one in, or check Windows' sound settings."; }
            catch (Exception ex) { return "Recording isn't available on this PC: " + ex.Message; }
        }

        public void Start()
        {
            if (IsRecording) return;
            var p = Problem();
            if (p != null) throw new InvalidOperationException(p);
            lock (_gate) _pcm.SetLength(0);
            _order.Clear();
            _stopping = false;
            _event = new AutoResetEvent(false);
            var fmt = new WaveFormatEx { wFormatTag = 1, nChannels = Wav.Channels, nSamplesPerSec = Wav.Rate, nAvgBytesPerSec = Wav.Rate * 2, nBlockAlign = 2, wBitsPerSample = Wav.Bits, cbSize = 0 };
            int rc = waveInOpen(out var h, WaveMapper, ref fmt, _event.SafeWaitHandle.DangerousGetHandle(), IntPtr.Zero, CallbackEvent);
            if (rc != 0) { _event.Dispose(); _event = null; throw new InvalidOperationException("The microphone can't record 16 kHz mono (waveIn error " + rc + "): check it isn't in use, and that Windows lets apps use the microphone."); }
            _handle = h;
            _headers = new IntPtr[Buffers];
            _data = new IntPtr[Buffers];
            for (int i = 0; i < Buffers; i++)
            {
                _data[i] = Marshal.AllocHGlobal(BufferBytes);
                _headers[i] = Marshal.AllocHGlobal(HdrSize);
                Marshal.StructureToPtr(new WaveHdr { lpData = _data[i], dwBufferLength = BufferBytes }, _headers[i], false);
                waveInPrepareHeader(_handle, _headers[i], HdrSize);
                waveInAddBuffer(_handle, _headers[i], HdrSize);
                _order.Enqueue(i);
            }
            _thread = new Thread(Pump) { IsBackground = true, Name = "Formcraft voice note", Priority = ThreadPriority.AboveNormal };
            _thread.Start();
            waveInStart(_handle);
        }

        private void Pump()
        {
            while (!_stopping)
            {
                _event?.WaitOne(250);
                Harvest(requeue: true);
            }
        }

        /// <summary>Copies the finished buffers, oldest first, and (while recording) hands them back to the driver.</summary>
        private void Harvest(bool requeue)
        {
            while (_order.Count > 0)
            {
                int i = _order.Peek();
                var hdr = (WaveHdr)Marshal.PtrToStructure(_headers[i], typeof(WaveHdr))!;
                if ((hdr.dwFlags & WhdrDone) == 0) return;
                _order.Dequeue();
                if (hdr.dwBytesRecorded > 0)
                {
                    var bytes = new byte[hdr.dwBytesRecorded];
                    Marshal.Copy(hdr.lpData, bytes, 0, bytes.Length);
                    lock (_gate) if (_pcm.Length < MaxLength.TotalSeconds * Wav.Rate * 2) _pcm.Write(bytes, 0, bytes.Length);
                }
                if (!requeue || _stopping) continue;
                hdr.dwFlags &= ~(uint)WhdrDone;
                hdr.dwBytesRecorded = 0;
                Marshal.StructureToPtr(hdr, _headers[i], false);
                waveInAddBuffer(_handle, _headers[i], HdrSize);
                _order.Enqueue(i);
            }
        }

        private byte[] Close()
        {
            if (!IsRecording) return new byte[0];
            _stopping = true;
            _event?.Set();
            _thread?.Join(2000);
            waveInStop(_handle);
            waveInReset(_handle);   // the driver marks every queued buffer done, with what it holds
            Harvest(requeue: false);
            for (int i = 0; i < _headers.Length; i++)
            {
                waveInUnprepareHeader(_handle, _headers[i], HdrSize);
                Marshal.FreeHGlobal(_headers[i]);
                Marshal.FreeHGlobal(_data[i]);
            }
            waveInClose(_handle);
            _handle = IntPtr.Zero;
            _headers = new IntPtr[0];
            _data = new IntPtr[0];
            _event?.Dispose();
            _event = null;
            lock (_gate) return _pcm.ToArray();
        }

        public string Stop()
        {
            var pcm = Close();
            if (pcm.Length < Wav.Rate * 2 / 2) throw new InvalidOperationException("The recording is shorter than half a second: press Record, speak, then Stop.");
            return Wav.WriteTemp(pcm);
        }

        public void Discard() => Close();
    }

    /// <summary>A stand-in for tests and the preview: "records" a second of silence.</summary>
    public sealed class MockVoiceRecorder : IVoiceRecorder
    {
        public bool IsRecording { get; private set; }
        public string? NoMicrophone { get; set; }
        public List<string> Written { get; } = new List<string>();
        public TimeSpan Elapsed => IsRecording ? TimeSpan.FromSeconds(1) : TimeSpan.Zero;
        public string? Problem() => NoMicrophone;
        public void Start() { if (NoMicrophone != null) throw new InvalidOperationException(NoMicrophone); IsRecording = true; }
        public void Discard() => IsRecording = false;

        public string Stop()
        {
            IsRecording = false;
            var path = Wav.WriteTemp(new byte[Wav.Rate * 2]);
            Written.Add(path);
            return path;
        }
    }
}
