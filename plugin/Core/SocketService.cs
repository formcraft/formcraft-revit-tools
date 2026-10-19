using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using Autodesk.Revit.UI;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using RevitMCPSDK.API.Models.JsonRPC;
using RevitMCPSDK.API.Interfaces;
using revit_mcp_plugin.Configuration;
using revit_mcp_plugin.Utils;
using revit_mcp_plugin.Fmc;

namespace revit_mcp_plugin.Core
{
    public class SocketService
    {
        private static SocketService _instance;
        private TcpListener _listener;
        private Thread _listenerThread;

        // F-064: one command at a time on Revit's API thread. A command that arrives while another runs waits its turn here
        // (recorded as "queued", with heartbeats) instead of timing out on its own external event and being refused.
        private static readonly SemaphoreSlim ApiQueue = new SemaphoreSlim(1, 1);
        // F-072: calls served without Revit's API thread (they read no model), so they answer while the bridge is busy
        private static readonly System.Collections.Generic.HashSet<string> NoApiThread =
            new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase) { "fmc_selftest_facts" };
        private static int _waiting;
        // The last fmc_document_info answer: given (marked cached) while another command holds Revit, whose UI is frozen
        // then, so the active document can't change. The live-model lock reads it instead of timing out.
        private static JToken _lastDocInfo;
        private static DateTime _lastDocInfoAt;
        private bool _isRunning;
        private int _port = 8080;
        private UIApplication _uiApp;
        private ICommandRegistry _commandRegistry;
        private ILogger _logger;
        private CommandExecutor _commandExecutor;

        public static SocketService Instance
        {
            get
            {
                if(_instance == null)
                    _instance = new SocketService();
                return _instance;
            }
        }

        private SocketService()
        {
            _commandRegistry = new RevitCommandRegistry();
            _logger = new Logger();
        }

        public bool IsRunning => _isRunning;

        /// <summary>How many Revits can each have their own connection (ports from the configured one up).</summary>
        public const int PortRange = 10;

        /// <summary>Why the last Start failed, in words a person can act on; empty when it started.</summary>
        public string LastError { get; private set; } = "";

        public int Port
        {
            get => _port;
            set => _port = value;
        }

        // 初始化
        // Initialization.
        public void Initialize(UIApplication uiApp)
        {
            _uiApp = uiApp;

            // 初始化事件管理器
            // Initialize ExternalEventManager
            ExternalEventManager.Instance.Initialize(uiApp, _logger);
            // F-072: the probe that tells when a command that outlived its wait has finished (made here, on the API thread)
            BridgeBusy.Initialize();
            // F-022: keep Revit's loop awake while a command waits, so background work runs while the person uses other apps.
            RevitWake.Initialize(uiApp);

            // 记录当前 Revit 版本
            // Get the current Revit version.
            var versionAdapter = new RevitMCPSDK.API.Utils.RevitVersionAdapter(_uiApp.Application);
            string currentVersion = versionAdapter.GetRevitVersion();
            _logger.Info("当前 Revit 版本: {0}\nCurrent Revit version: {0}", currentVersion);



            // 创建命令执行器
            // Create CommandExecutor
            _commandExecutor = new CommandExecutor(_commandRegistry, _logger);

            // 加载配置并注册命令
            // Load configuration and register commands.
            ConfigurationManager configManager = new ConfigurationManager(_logger);
            configManager.LoadConfiguration();


            //// 从配置中读取服务端口
            //// Read the service port from the configuration.
            //if (configManager.Config.Settings.Port > 0)
            //{
            //    _port = configManager.Config.Settings.Port;
            //}
            // Formcraft: the port comes from %APPDATA%\Formcraftmc_connect.json, which the MCP server reads too.
            _port = ConnectSettings.Load().Port;

            // 加载命令
            // Load command.
            CommandManager commandManager = new CommandManager(
                _commandRegistry, _logger, configManager, _uiApp);
            commandManager.LoadCommands();
            // Formcraft: the self-test's facts come from the add-in itself (build stamp, this registry, ribbon, kit folder).
            _commandRegistry.RegisterCommand(new FmcSelfTestCommand(() => new System.Collections.Generic.List<string>(((RevitCommandRegistry)_commandRegistry).GetRegisteredCommands())));

            _logger.Info($"Socket service initialized on port {_port}");
        }

        public void Start()
        {
            if (_isRunning) return;

            // Two or more Revits each get their own connection: the first free port from the configured one up (8080-8089),
            // announced in %APPDATA%\Formcraft\instances so the MCP server can reach each of them.
            int first = ConnectSettings.Load().Port;
            try
            {
                LastError = "";
                for (int port = first; port < first + PortRange; port++)
                {
                    try
                    {
                        // This PC only: AI apps reach Revit through the MCP server running here, never over the network.
                        _listener = new TcpListener(IPAddress.Loopback, port);
                        _listener.Start();
                        _port = port;
                        break;
                    }
                    catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
                    {
                        _listener = null;
                    }
                }
                if (_listener == null)
                {
                    LastError = $"Ports {first}-{first + PortRange - 1} are all in use ({PortRange} Revits or other programs). Close one, or set another port in {ConnectSettings.FilePath} and restart Revit.";
                    return;
                }
                _isRunning = true;
                _listenerThread = new Thread(ListenForClients)
                {
                    IsBackground = true
                };
                _listenerThread.Start();
                InstanceRegistry.Announce(_port);
            }
            catch (Exception ex)
            {
                _isRunning = false;
                _listener = null;
                LastError = ex.Message;
            }
        }

        public void Stop()
        {
            if (!_isRunning) return;
            InstanceRegistry.Remove();

            try
            {
                _isRunning = false;

                _listener?.Stop();
                _listener = null;

                if(_listenerThread!=null && _listenerThread.IsAlive)
                {
                    _listenerThread.Join(1000);
                }
            }
            catch (Exception)
            {
                // log error
            }
        }

        private void ListenForClients()
        {
            try
            {
                while (_isRunning)
                {
                    TcpClient client = _listener.AcceptTcpClient();

                    Thread clientThread = new Thread(HandleClientCommunication)
                    {
                        IsBackground = true
                    };
                    clientThread.Start(client);
                }
            }
            catch (SocketException)
            {

            }
            catch(Exception)
            {
                // log
            }
        }

        private void HandleClientCommunication(object clientObj)
        {
            TcpClient tcpClient = (TcpClient)clientObj;
            NetworkStream stream = tcpClient.GetStream();
            ActivityLog.ClientConnected();

            try
            {
                byte[] buffer = new byte[65536];
                // F-031: a request may arrive in many reads (a 10 KB script is more than one 8 KB read); answer each whole one.
                var frames = new JsonFrameReader();

                while (_isRunning && tcpClient.Connected)
                {
                    // 读取客户端消息
                    // Read client messages.
                    int bytesRead = 0;

                    try
                    {
                        bytesRead = stream.Read(buffer, 0, buffer.Length);
                    }
                    catch (IOException)
                    {
                        // 客户端断开连接
                        // Client disconnected.
                        break;
                    }

                    if (bytesRead == 0)
                    {
                        // 客户端断开连接
                        // Client disconnected.
                        break;
                    }

                    System.Collections.Generic.List<string> messages;
                    try
                    {
                        messages = frames.Feed(buffer, bytesRead);
                    }
                    catch (InvalidDataException ex)
                    {
                        byte[] refusal = Encoding.UTF8.GetBytes(CreateErrorResponse(null, JsonRPCErrorCodes.InvalidRequest, ex.Message));
                        stream.Write(refusal, 0, refusal.Length);
                        break;
                    }

                    foreach (string message in messages)
                    {
                        System.Diagnostics.Trace.WriteLine($"Received message: {message.Length} characters");

                        string response = ProcessJsonRPCRequest(message);

                        // 发送响应
                        // Send response.
                        byte[] responseData = Encoding.UTF8.GetBytes(response);
                        stream.Write(responseData, 0, responseData.Length);
                    }
                }
            }
            catch(Exception)
            {
                // log
            }
            finally
            {
                ActivityLog.ClientDisconnected();
                tcpClient.Close();
            }
        }

        private string ProcessJsonRPCRequest(string requestJson)
        {
            JsonRPCRequest request;

            try
            {
                // 解析JSON-RPC请求
                // Parse JSON-RPC requests.
                request = JsonConvert.DeserializeObject<JsonRPCRequest>(requestJson);

                // 验证请求格式是否有效
                // Verify that the request format is valid.
                if (request == null || !request.IsValid())
                {
                    return CreateErrorResponse(
                        null,
                        JsonRPCErrorCodes.InvalidRequest,
                        "Invalid JSON-RPC request"
                    );
                }

                // 查找命令
                // Search for the command in the registry.
                if (!_commandRegistry.TryGetCommand(request.Method, out var command))
                {
                    ActivityLog.Add(request.Method, false, 0, "Not enabled in the add-in's command settings");
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.MethodNotFound,
                        $"Method '{request.Method}' not found");
                }

                // 执行命令
                // Execute command.
                var watch = System.Diagnostics.Stopwatch.StartNew();
                // F-030: every call is a job; its id is the request id, passed to the command set as _fmcJob (cancel checks,
                // the job's failures and dialogs). A call that runs long is recorded in FMC_Jobs_Revit.jsonl for fmc_job.
                JObject parameters = request.GetParamsObject() ?? new JObject();
                if (!string.IsNullOrEmpty(request.Id)) parameters["_fmcJob"] = request.Id;

                // F-064: while another command holds Revit, the active document can't change: answer from the last reading
                bool forDocument = parameters["document"] != null && parameters["document"].Type != JTokenType.Null;
                if (request.Method == "fmc_document_info" && !forDocument && RevitWake.InFlight > 0 && _lastDocInfo is JObject cached)
                {
                    var answer = (JObject)cached.DeepClone();
                    answer["cached"] = true;
                    answer["cached_at"] = _lastDocInfoAt.ToString("o");
                    answer["why_cached"] = "Revit is running another command, so its interface (and the active document) can't change until it ends";
                    ActivityLog.Add(request.Method, true, watch.ElapsedMilliseconds, "cached: Revit busy");
                    return CreateSuccessResponse(request.Id, answer);
                }

                // F-072: a command that doesn't need Revit's API thread answers while the bridge is busy
                if (NoApiThread.Contains(request.Method) && BridgeBusy.IsBusy)
                {
                    try
                    {
                        object facts = command.Execute(parameters, request.Id);
                        ActivityLog.Add(request.Method, true, watch.ElapsedMilliseconds, "while Revit is busy");
                        return CreateSuccessResponse(request.Id, facts);
                    }
                    catch (Exception ex)
                    {
                        ActivityLog.Add(request.Method, false, watch.ElapsedMilliseconds, ex.Message);
                        return CreateErrorResponse(request.Id, JsonRPCErrorCodes.InternalError, ex.Message);
                    }
                }
                // F-072: an earlier command's work still holds Revit's API thread (its wait ran out): say so at once, never
                // queue behind it and time out
                if (BridgeBusy.Refusal(out string busy))
                {
                    ActivityLog.Add(request.Method, false, watch.ElapsedMilliseconds, "refused: Revit busy");
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.InternalError, busy);
                }

                var job = RevitJobLog.Watch(request.Id, request.Method);
                bool entered = false;
                try
                {
                    if (!ApiQueue.Wait(0))
                    {
                        int ahead = Interlocked.Increment(ref _waiting);
                        job.Queued(ahead);
                        try { ApiQueue.Wait(); } finally { Interlocked.Decrement(ref _waiting); }
                        job.LeftQueue();
                    }
                    entered = true;
                    // queued behind the command that went busy: refused now, not sent to wait behind it
                    if (BridgeBusy.Refusal(out busy))
                    {
                        job.Done(false, busy);
                        ActivityLog.Add(request.Method, false, watch.ElapsedMilliseconds, "refused: Revit busy");
                        return CreateErrorResponse(request.Id, JsonRPCErrorCodes.InternalError, busy);
                    }
                    object result;
                    using (RevitWake.Busy())
                        result = command.Execute(parameters, request.Id);
                    if (request.Method == "fmc_document_info" && !forDocument && result != null)
                    {
                        _lastDocInfo = result as JToken ?? JToken.FromObject(result);
                        _lastDocInfoAt = DateTime.UtcNow;
                    }

                    job.Done(true, null, result);
                    ActivityLog.Add(request.Method, true, watch.ElapsedMilliseconds);
                    return CreateSuccessResponse(request.Id, result);
                }
                catch (Exception ex)
                {
                    // F-072: the wait ran out but the work may still run on Revit's API thread: the bridge is busy with it
                    // until it ends (its job record stays open, with heartbeats; its result is kept when it ends)
                    bool stillRunning = BridgeBusy.IsWaitTimeout(ex) && BridgeBusy.Mark(request.Method, request.Id, job.Started, job, command);
                    if (!stillRunning) job.Done(false, ex.Message);
                    ActivityLog.Add(request.Method, false, watch.ElapsedMilliseconds, ex.Message);
                    string message = stillRunning
                        ? $"[FMC-BRIDGE-TIMEOUT] {ex.Message}: the add-in stopped waiting after {Math.Round(watch.Elapsed.TotalSeconds)} s, but Revit is still running it (job {request.Id}). " +
                          "Until it ends, new calls are answered [FMC-BRIDGE-BUSY]; its result then goes to FMC_LateResults.jsonl (fmc_job result " + request.Id + ")."
                        : ex.Message;
                    return CreateErrorResponse(request.Id, JsonRPCErrorCodes.InternalError, message);
                }
                finally
                {
                    if (entered) ApiQueue.Release();
                }
            }
            catch (JsonException)
            {
                // JSON解析错误
                // JSON parsing error.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.ParseError,
                    "Invalid JSON"
                );
            }
            catch (Exception ex)
            {
                // 处理请求时的其他错误
                // Catch other errors produced when processing requests.
                return CreateErrorResponse(
                    null,
                    JsonRPCErrorCodes.InternalError,
                    $"Internal error: {ex.Message}"
                );
            }
        }

        private string CreateSuccessResponse(string id, object result)
        {
            var response = new JsonRPCSuccessResponse
            {
                Id = id,
                Result = result is JToken jToken ? jToken : JToken.FromObject(result)
            };

            return response.ToJson();
        }

        private string CreateErrorResponse(string id, int code, string message, object data = null)
        {
            var response = new JsonRPCErrorResponse
            {
                Id = id,
                Error = new JsonRPCError
                {
                    Code = code,
                    Message = message,
                    Data = data != null ? JToken.FromObject(data) : null
                }
            };

            return response.ToJson();
        }
    }
}
