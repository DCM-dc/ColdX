// ColdX Windows adapter. Data-only protocol; no user-supplied code is evaluated.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace ColdXComputer {
  public static class Native {
    delegate bool EnumProc(IntPtr window, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Sequential)] struct KeyInput {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Explicit)] struct InputUnion {[FieldOffset(0)]public MouseInput mouse;[FieldOffset(0)]public KeyInput key;}
    [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public InputUnion value;}
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc,IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int capacity);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
    [StructLayout(LayoutKind.Sequential)] struct PointValue { public int x,y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(PointValue point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flag);
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=16*1024*1024 };
    static string cancelPath;
    static HashSet<ushort> heldKeys = new HashSet<ushort>();
    static uint heldButton;
    static Dictionary<string,object> Map(params object[] values) {var result=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)result[(string)values[i]]=values[i+1];return result;}
    static string Text(Dictionary<string,object> request,string name,string fallback="") {return request.ContainsKey(name)?Convert.ToString(request[name]):fallback;}
    static int Num(Dictionary<string,object> request,string name,int fallback=0) {return request.ContainsKey(name)?Convert.ToInt32(request[name]):fallback;}
    static void Check() {if(File.Exists(cancelPath))throw new OperationCanceledException("Desktop stopped.");}
    static Dictionary<string,object> Window(IntPtr handle) {
      Rect rect;uint pid;GetWindowRect(handle,out rect);GetWindowThreadProcessId(handle,out pid);
      var title=new StringBuilder(1024);GetWindowText(handle,title,title.Capacity);string process="";
      try {using(var p=Process.GetProcessById((int)pid))process=p.ProcessName;}catch{}
      return Map("id",handle.ToInt64().ToString(),"pid",pid,"processName",process,"title",title.ToString(),"bounds",Map("x",rect.left,"y",rect.top,"width",rect.right-rect.left,"height",rect.bottom-rect.top),"foreground",GetForegroundWindow()==handle,"minimized",IsIconic(handle));
    }
    static List<object> Windows() {
      var windows=new List<object>();EnumWindows((handle,param)=>{if(IsWindowVisible(handle)){var info=Window(handle);if(((string)info["title"]).Length>0)windows.Add(info);}return true;},IntPtr.Zero);return windows;
    }
    static IntPtr Resolve(string id) {
      long value;if(!Int64.TryParse(id,out value)||value<=0)throw new Exception("A valid window id is required.");
      var handle=new IntPtr(value);if(!IsWindowVisible(handle))throw new Exception("Window closed or not visible. Refresh the window list.");return handle;
    }
    static void Send(Input input) {if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(Input)))!=1)throw new Exception("Windows blocked input. Verify the window is not elevated and the desktop is unlocked.");}
    static void Mouse(uint flag,uint data=0) {Send(new Input {type=0,value=new InputUnion{mouse=new MouseInput{flags=flag,data=data}}});}
    static void Key(ushort key,bool up,bool unicode=false) {Send(new Input{type=1,value=new InputUnion{key=new KeyInput{vk=unicode?(ushort)0:key,scan=unicode?key:(ushort)0,flags=(up?2u:0u)|(unicode?4u:0u)}}});}
    public static void ReleaseInputs() {
      foreach(var key in heldKeys)try{Key(key,true);}catch{}heldKeys.Clear();
      if(heldButton!=0)try{Mouse(heldButton);}catch{}heldButton=0;
    }
    static ushort KeyCode(string key) {
      if(key.Length==1&&Char.IsLetterOrDigit(key[0]))return (ushort)Char.ToUpperInvariant(key[0]);
      int f;if(key.StartsWith("F")&&Int32.TryParse(key.Substring(1),out f)&&f>=1&&f<=12)return (ushort)(111+f);
      var keys=new Dictionary<string,ushort>{{"Control",17},{"Alt",18},{"Shift",16},{"Meta",91},{"Enter",13},{"Escape",27},{"Tab",9},{"Backspace",8},{"Delete",46},{"Space",32},{"ArrowUp",38},{"ArrowDown",40},{"ArrowLeft",37},{"ArrowRight",39},{"Home",36},{"End",35},{"PageUp",33},{"PageDown",34}};
      if(!keys.ContainsKey(key))throw new Exception("Unsupported key.");return keys[key];
    }
    static void AssertWindow(IntPtr handle,Dictionary<string,object> request) {
      if(GetForegroundWindow()!=handle)throw new Exception("Foreground changed. Focus and observe the window again.");
      if(!request.ContainsKey("expectedWindow"))throw new Exception("Observation identity is missing.");
      var expected=(Dictionary<string,object>)request["expectedWindow"];var actual=Window(handle);
      if(Convert.ToInt64(expected["pid"])!=Convert.ToInt64(actual["pid"])||json.Serialize(expected["bounds"])!=json.Serialize(actual["bounds"]))throw new Exception("Window changed since observation.");
    }
    static void Point(IntPtr handle,Dictionary<string,object> request,string x,string y) {
      Rect rect;GetWindowRect(handle,out rect);int px=Num(request,x),py=Num(request,y);
      if(px<0||py<0||px>=rect.right-rect.left||py>=rect.bottom-rect.top)throw new Exception("Point is outside the observed window.");
      var hit=WindowFromPoint(new PointValue{x=rect.left+px,y=rect.top+py});
      if(GetAncestor(hit,2)!=handle)throw new Exception("The target point is covered by another window. Observe again.");
      if(!SetCursorPos(rect.left+px,rect.top+py))throw new Exception("Cannot position the pointer.");
    }
    static List<object> Controls(IntPtr handle,Rect bounds) {
      var result=new List<object>();var started=Stopwatch.StartNew();
      try {
        var queue=new Queue<Tuple<AutomationElement,int>>();queue.Enqueue(Tuple.Create(AutomationElement.FromHandle(handle),0));
        var walker=TreeWalker.ControlViewWalker;
        while(queue.Count>0&&result.Count<120&&started.ElapsedMilliseconds<500) {
          var item=queue.Dequeue();var element=item.Item1;var info=element.Current;
          if(!info.IsPassword&&!info.IsOffscreen) {
            var r=info.BoundingRectangle;string name=info.Name??"";if(name.Length>180)name=name.Substring(0,180);
            if(name.Length>0)result.Add(Map("name",name,"role",info.ControlType.ProgrammaticName,"enabled",info.IsEnabled,"bounds",Map("x",r.X-bounds.left,"y",r.Y-bounds.top,"width",r.Width,"height",r.Height)));
          }
          if(item.Item2<5) {var child=walker.GetFirstChild(element);int siblings=0;while(child!=null&&siblings++<80&&queue.Count<200){queue.Enqueue(Tuple.Create(child,item.Item2+1));child=walker.GetNextSibling(child);}}
        }
      }catch{}return result;
    }
    static object Observe(IntPtr handle) {
      Check();if(IsIconic(handle))throw new Exception("Window is minimized. Focus it before observation.");
      Rect rect;GetWindowRect(handle,out rect);int width=rect.right-rect.left,height=rect.bottom-rect.top;
      if(width<1||height<1||(long)width*height>16000000)throw new Exception("Window dimensions cannot be captured.");
      string data;
      using(var bitmap=new Bitmap(width,height))using(var graphics=Graphics.FromImage(bitmap))using(var stream=new MemoryStream()) {
        graphics.CopyFromScreen(rect.left,rect.top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
        bitmap.Save(stream,ImageFormat.Jpeg);data=Convert.ToBase64String(stream.ToArray());
      }
      return Map("window",Window(handle),"width",width,"height",height,"image",Map("mime","image/jpeg","base64",data),"controls",Controls(handle,rect));
    }
    static object Execute(Dictionary<string,object> request) {
      Check();string action=Text(request,"action");
      if(action=="probe")return Map("available",true,"backend","windows-native","pointerSize",IntPtr.Size);
      if(action=="windows")return Map("windows",Windows());
      var handle=Resolve(Text(request,"windowId"));
      if(action=="focus") {ShowWindow(handle,9);SetForegroundWindow(handle);Thread.Sleep(120);if(GetForegroundWindow()!=handle)throw new Exception("Windows did not allow focus. Select this window manually, then observe again.");return Observe(handle);}
      if(action=="observe")return Observe(handle);
      AssertWindow(handle,request);Check();
      try {
        if(action=="click"||action=="double_click"||action=="drag") {
          Point(handle,request,"x","y");string button=Text(request,"button","left");uint down=button=="right"?8u:button=="middle"?32u:2u;uint up=down*2;
          int count=action=="double_click"?2:1;
          for(int c=0;c<count;c++) {Check();AssertWindow(handle,request);heldButton=up;Mouse(down);
            if(action=="drag") {Rect rect;GetWindowRect(handle,out rect);int x=Num(request,"x"),y=Num(request,"y"),ex=Num(request,"endX"),ey=Num(request,"endY");if(ex<0||ey<0||ex>=rect.right-rect.left||ey>=rect.bottom-rect.top)throw new Exception("Drag end is outside the window.");for(int i=1;i<=20;i++){Check();if(GetForegroundWindow()!=handle)throw new Exception("Foreground changed while dragging.");SetCursorPos(rect.left+x+(ex-x)*i/20,rect.top+y+(ey-y)*i/20);Thread.Sleep(15);}}
            Mouse(up);heldButton=0;if(count>1)Thread.Sleep(70);
          }
        }else if(action=="type") {
          string text=Text(request,"text");if(text.Length>20000)throw new Exception("Text is too large.");
          foreach(char c in text){Check();if(GetForegroundWindow()!=handle)throw new Exception("Foreground changed while typing.");Key(c,false,true);Key(c,true,true);}
        }else if(action=="key") {
          var keys=(ArrayList)request["keys"];if(keys.Count<1||keys.Count>5)throw new Exception("Invalid key combination.");
          foreach(var name in keys){Check();ushort key=KeyCode((string)name);heldKeys.Add(key);Key(key,false);}
        }else if(action=="scroll") {
          int dx=Num(request,"deltaX"),dy=Num(request,"deltaY");if(Math.Abs(dx)>2400||Math.Abs(dy)>2400)throw new Exception("Scroll is too large.");
          if(request.ContainsKey("x")&&request.ContainsKey("y"))Point(handle,request,"x","y");else{Rect rect;GetWindowRect(handle,out rect);Point(handle,Map("x",(rect.right-rect.left)/2,"y",(rect.bottom-rect.top)/2),"x","y");}
          if(dy!=0)Mouse(0x800,unchecked((uint)-dy));if(dx!=0)Mouse(0x1000,unchecked((uint)dx));
        }else throw new Exception("Unsupported desktop action.");
      }finally{ReleaseInputs();}
      Thread.Sleep(100);Check();return Observe(handle);
    }
    public static string Dispatch(string line,string cancellationPath) {
      object id=null;cancelPath=cancellationPath;
      try{SetThreadDpiAwarenessContext(new IntPtr(-4));var request=json.Deserialize<Dictionary<string,object>>(line);id=request["id"];return json.Serialize(Map("id",id,"ok",true,"value",Execute(request)));}
      catch(Exception error){ReleaseInputs();return json.Serialize(Map("id",id,"ok",false,"error",error.Message));}
    }
  }
}
