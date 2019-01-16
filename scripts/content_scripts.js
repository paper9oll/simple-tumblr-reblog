// ==UserScript==
// @name           Super Tumblr Reblog
// @namespace      http://userscripts.org/users/smrots
// @description    Reblog like a boss
//                 * Selects "add to queue" by default
//                 * Press 1, 2, 3, ... through 0 to select your blogs
//                 * Change your default blog
//                 * Press r key to reblog from a post page
//                 Handcrafted by http://userscripts.org/users/smrots
// @include        http*://*.tumblr.com/reblog/*
// @include        http*://*.tumblr.com/post/*
// @include        http*://*.tumblr.com/dashboard*
// @include        http*://*.tumblr.com/*activity
// @include        http*://*.tumblr.com/*
// @version        1.7
// @run-at         document-start
// @grant          none
// ==/UserScript==

var g_defaultBlogIndex = 0;
var g_defaultPostActionIndex = 0; // post
var g_autoPostWhenQueueFull = false;
var g_autoBestOf = false;
var g_lastSeenPostOptions = null;
var g_hasSetDefaultBlog = false;
var g_lastSeenMCEframe = null;
var g_tumblrPrimaryBlog = '_unknown';
var g_blogLink = null;
var g_blogName = null;
var g_sourceBlogName = null;
var g_devMode = false;
var g_pollInterval = 500; // ms
var g_maxPolls = 20;
var g_numPolls = 0;
var g_poller = null;
var g_userBlogs = [];
var g_autoFavBlogs = {}; // { userBlog: fav source blogs }

var g_skipPageOffset = 0;
var parts = document.URL.split("/");
if (parts[3] == 'dashboard')
{
  var pageNum = parts[4];
  if (pageNum)
    g_skipPageOffset = parseInt(pageNum);
}

var CANCEL_POST_BUTTON = 'button.flat-button.post-form--close';
var CREATE_POST_BUTTON = '.post-form--save-button .create_post_button';
var CAPTION_EDITOR = '.caption-field .editor-wrapper .editor';
var TAG_LABELS = '.post-form--tag-editor .tag-label';
var TAG_EDITOR = '.post-form--tag-editor .editor';
var TAG_CONTAINER = '.post-form--tag-editor';
var SR_INDICATOR = "#super-reblog-indicator";

// get user settings
chrome.storage.sync.get({
  reblogBehavior: "queue",
  defaultBlog: 0,
  queueBehavior: false,
  autoBestOf: false
}, function(items) {
  g_defaultBlogIndex = items.defaultBlog;
  g_autoPostWhenQueueFull = items.queueBehavior;
  g_autoBestOf = items.autoBestOf;
  if (items.reblogBehavior == "post")
    g_defaultPostActionIndex = 0;
  else
    g_defaultPostActionIndex = 1;

  restartPoller(); // fire poller to update
});

chrome.storage.sync.get('primaryBlog', function(item) {
  if (item.primaryBlog)
    g_tumblrPrimaryBlog = item.primaryBlog;
});

chrome.storage.sync.get('userBlogs', function(item) {
  if (item.userBlogs)
    g_userBlogs = item.userBlogs.split(",");

  for (ubi in g_userBlogs)
  {
    var ublog = g_userBlogs[ubi];
    var key = 'autoFavBlogs_' + ublog;

    chrome.storage.sync.get(key, function(item) {
      var key = null;
      for (k in item)
        if (item.hasOwnProperty(k))
        {
          key = k;
          break;
        }

      if (!key)
        return;

      var ublog = key.split("autoFavBlogs_")[1];

      //console.log(key + " " + ublog + " " + item[key]);

      if (item[key])
      {
        // replace list of autofav blogs with stored list
        g_autoFavBlogs[ublog] = JSON.parse(item[key]);

        if (isDash() || isBlog())
        {
          addMonsterToMenuBlog(ublog);
          addMonster();
        }
      }
    });
  }
});

$(document).ready(function() {
  chrome.storage.sync.get('isDev', function(item) {
    if (item.isDev)
      g_devMode = true;
    else
    {
      var checkDiv = $("#post_controls_avatar");
      if (checkDiv.length && checkDiv.data('blog-url').indexOf("journalofthisandthat") != -1)
      {
        /*
         * login with dashboard to enable devMode
         */
        chrome.storage.sync.set({'isDev': true},
          function() {});

        // local devMode settings
        g_devMode = true;
      }
    }

    chrome.runtime.sendMessage(
      // tell background script to save devMode state
      {
        action: "set-devmode",
        devMode: g_devMode
      }, function() { });

    // call these here because they depend on g_devMode being set
    checkDoAutoClose();
    checkDoAutoPost();
  });
});

function isReblogging()
{
  if (document.URL.indexOf("/reblog/") != -1)
    return true;

  return false;
}

function isBlog()
{
  if (document.URL.indexOf("/blog/") != -1)
    return true;

  return false;
}

function isActivity()
{
  if (document.URL.indexOf("/activity") != -1)
    return true;

  return false;
}

function isDash()
{
  if (document.URL.indexOf("/dashboard") != -1)
    return true;

  return false;
}

function isPost()
{
  if (document.URL.indexOf("/post") != -1)
    return true;

  return false;
}

function isEditing()
{
  if (document.URL.indexOf("/edit/") != -1)
    return true;

  return false;
}

function restartPoller()
{
  // tick until expires
  //if (g_devMode)
  //  console.log("restart poller");

  g_numPolls = 0;
  stopPoller();
  g_poller = setInterval(doMainWork, g_pollInterval);
}

function stopPoller()
{
  if (!g_poller)
    return;

  clearInterval(g_poller);
  delete g_poller;
  g_poller = null;

  //if (g_devMode)
  //  console.log("stop poller");
}

function detectNewPostPopup()
{
  var modal = $(".post-forms-modal");
  if (!modal.length || !modal.is(":visible"))
    return false;

  var po = $(".post-form--save-button");
  if (!po)
    return false;

  if (po[0] !== g_lastSeenPostOptions
   || $(SR_INDICATOR).length <= 0)
  {
    g_lastSeenPostOptions = po[0];
    return true;
  }

  return false;
}

function doMainWork()
{
  if (g_numPolls++ > g_maxPolls)
  {
    stopPoller();
    return;
  }

  collectPostBlogsForAutoBestOf();
  hideSponsoredPosts();
  hideUnderlay();
  updateIndicator();
  modifyPostControls();
  autoPostNowIfQueueFull();

  var isNewPopup = detectNewPostPopup();
  if (isNewPopup && !isEditing())
  {
    /*
     * Add to queue by default
     */
    selectPostAction(g_defaultPostActionIndex);

    /*
     * Add blog select indicator
     */
    if (!$(SR_INDICATOR).length)
    {
      var postControlsSpot = $(".post-form--controls .controls-container .control.left");
      if (postControlsSpot)
      {
        var blogIndicator = $("<div/>", {
          id: 'super-reblog-indicator',
          class: 'control right'
        });
        blogIndicator.insertAfter(postControlsSpot);
      }
    }

    /*
     * Select default blog
     */
    g_hasSetDefaultBlog = selectBlog(g_defaultBlogIndex);
  }

  var mceFrame = $(CAPTION_EDITOR);
  if (mceFrame
    && (mceFrame[0] !== g_lastSeenMCEframe || isNewPopup))
  {
      g_lastSeenMCEframe = mceFrame[0];

      if (g_devMode)
      {
        // clear existing caption
        mceFrame.html("");
        $(".post-form--form .remove-button").click();
      }

      //stopPoller(); // we found what we were looking for

      var clickTriggerTag = 'str-click-trigger';
      var createPostButton = $(".post-form--save-button");
      if (createPostButton.length
        && !createPostButton.data(clickTriggerTag))
      {
        // new post button
        // bind click event to create_post button
        createPostButton.data(clickTriggerTag, 1); // no dup events
        createPostButton.click(function() {
          // send GA tracking event
          var postAction = createPostButton.find(".caption").text();
          var blogName = '_unknown_target';
          var selected = $('.tumblelog-select .caption');
          if (selected)
            blogName = selected.text();

          var source = getReblogSource();

          // save reblog source
          saveFavBlog(blogName, source);

          gaSendEvent('create_post',
            blogName,  postAction + " " + source);
        });
      }
      else if (!createPostButton || !createPostButton.length)
      {
        //console.log('no post button?');
      }
  }

  if (g_devMode && isActivity())
    nukeLameNotes();
}

function getHashLength(hash)
{
  var size = 0, key;
  for (key in hash) {
    if (hash.hasOwnProperty(key))
      size++;
  }
  return size;
}

function getAllFavBlogs()
{
  var blogs = new Array();

  for (key in g_autoFavBlogs)
    if (g_autoFavBlogs.hasOwnProperty(key))
      blogs.push.apply(blogs, getFavBlogsList(key));

  return blogs;
}

function getFavBlogsList(myBlog)
{
  var blogs = new Array();

  if (!g_autoFavBlogs.hasOwnProperty(myBlog))
    return blogs;

  for (b in g_autoFavBlogs[myBlog])
    if (g_autoFavBlogs[myBlog].hasOwnProperty(b))
      blogs.push(b);

  return blogs;
}

function saveFavBlog(myBlog, blog)
{
  var maxSize = 200; // max num blogs to save in favs

  var chopIndex = blog.indexOf(".tumblr.com");
  if (chopIndex != -1)
    blog = blog.substring(0, chopIndex);

  if (!g_autoFavBlogs.hasOwnProperty(myBlog))
    g_autoFavBlogs[myBlog] = {};

  g_autoFavBlogs[myBlog][blog] = (new Date).getTime();

  var blogs = getFavBlogsList(myBlog);

  var dayInMilliseconds = 86400000;
  // only keep blogs up to 60 days old
  var timeCutoff = ((new Date).getTime())
      - (60 * dayInMilliseconds);

  if (blogs.length > maxSize)
  {
    // reverse sort, newest on left, oldest on right
    blogs.sort(function(a, b) {
      return g_autoFavBlogs[myBlog][b] - g_autoFavBlogs[myBlog][a];
    });

    timeCutoff = Math.min(timeCutoff,
        g_autoFavBlogs[myBlog][blogs[maxSize]]);
  }

  // delete old blogs
  for (i=0; i < blogs.length; i++)
  {
    var b = blogs[i];
    if (g_autoFavBlogs[myBlog][b] <= timeCutoff)
      delete g_autoFavBlogs[myBlog][b];
  }

  var key = 'autoFavBlogs_' + myBlog;
  var json = JSON.stringify(g_autoFavBlogs[myBlog]);
  var saveData = {};
  saveData[key] = json;
  chrome.storage.sync.set(saveData, function() {});
}

function selectPostAction(actionIdx)
{
  //var po = document.getElementById("post_options");
  var po = $(".post-form--save-button");
  if (!po.length)
    return;

  g_lastSeenPostOptions = po[0];

  //var optionsDropdown = po.find("div.options");
  var optionsDropdown = po.find(".dropdown-area");
  if (!optionsDropdown.length)
    return;

  optionsDropdown.click();

  //var actionSelector = po.children[0].children[0].children[0];
  //if (actionSelector)
  //  actionSelector.children[actionIdx].children[0].click();
  var dropdown = $(".popover--save-post-dropdown");
  if (!dropdown.length)
    return;

  var actionSelector = dropdown.find(".item-option")[actionIdx];

  if (actionSelector)
    actionSelector.click();
}

function getReblogSource()
{
  var source = '_unknown_source.tumblr.com';

  var reblogName = $(".tumblelog-select .reblog_name");
  if (!reblogName.length)
     return source;

  source = reblogName.text() + ".tumblr.com";

  var reblogPost = $("#sourceUrl_input");

  if (reblogPost.length)
    source += ": " + reblogPost.val();

  return source;
}

function getSelectedBlog()
{
  var selectedCaption = $(".tumblelog-select .caption");
  if (!selectedCaption.length)
    return null;

  var name = selectedCaption.text();

  var avatar = $(".post-form--avatar .avatar-link");
  if (!avatar.length)
    return null;

  var bgStyle = avatar.css("background-image");
  url = bgStyle.replace(/"/g,"").replace(/url\(|\)$/ig, "");

  return { 'avatar': url, 'name': name };
}

function modifyPostControls()
{
  if (g_tumblrPrimaryBlog == '_unknown')
    return;

  if (!g_autoBestOf)
    return;

  $('.post_container').each(function() {
    var postContainer = $(this);
    var postNotesInner = postContainer.find(".post_notes_inner");
    if (!postNotesInner.length)
      return;

    var buttonKey = 'str-bestof-button';
    if (postNotesInner.data(buttonKey))
      return; // already modified
    postNotesInner.data(buttonKey, '1');

    var reblogSource = postContainer.find('.share_social_button');
    if (reblogSource && reblogSource.data('tumblelog-name'))
      reblogSource = reblogSource.data('tumblelog-name');
    else
      reblogSource = '';

    if (reblogSource)
    {
      var url = chrome.extension.getURL("bestof.html")
        + "?blog=" + reblogSource
        + "&pblog=" + g_tumblrPrimaryBlog
        + "&days=7";
      var jsOnClick = ' onmousedown="return false;" onmouseup="window.open(\'' + url
        + '\'); return false;" ';
      var title = ' title="top posts this week" ';
      var buttonHtml
        = '<div class="super-reblog-post-bestof-button" '
        + title + jsOnClick
        + '>' + reblogSource + "'s best of the week"
        + '</div>';
      postNotesInner.append(buttonHtml);
    }
  });
}

function updateIndicator()
{
  var selected = getSelectedBlog();
  if (!selected)
    return;

  var indicator = $(SR_INDICATOR);
  if (!indicator.length)
    return;

  blogAvatar = selected["avatar"];
  blogName = selected["name"];

  if (!blogAvatar || !blogName)
    return

  indicator.html(
      '<div class="super-reblog-indicator-blogname">'
      + blogName + '</div>'
      + '<div class="super-reblog-indicator-avatar"><img src="'
      + blogAvatar + '"> '
      + '</div>');
}

function selectBlog(blogIdx)
{
  var choices = $(".tumblelog-select .caption");
  if (!choices.length)
    return false;

  choices.click();

  var menu = $(".popover--tumblelog-select-dropdown");
  if (!menu.length)
    return false;

  var blogList = menu.find('ul');
  if (!blogList)
    return false;

  var blogListItem = null;
  if (isNaN(blogIdx))
  {
    // search menuitems for name match
    blogList.children('li').each(function() {
      var blogName = $(this).find('p.ts-name');
      if (blogName.length
        && blogName.text() == blogIdx)
        blogListItem = $(this);
    });
  }
  else
  {
    // directly get blog at index
    blogListItem = blogList.children('li:eq(' + blogIdx + ')');
  }

  if (!blogListItem || !blogListItem.length)
    return false;

  var blogButton = blogListItem.children('div:eq(0)');
  if (blogButton.length)
  {
    blogButton.click();
    updateIndicator();

    if (g_devMode)
    {
      g_blogName = blogButton.find(".ts-name").text();
      g_blogLink = "https://" + g_blogName + ".tumblr.com";
     }
  }

  var reblogName = $(".tumblelog-select .reblog_name");
  if (reblogName.length && g_devMode)
    g_sourceBlogName = reblogName.text();

  return true;
}

function getParam(url, name)
{
  var name = name.replace(/[\[]/, "\\\[").replace(/[\]]/, "\\\]");
  var regexS = "[\\?&]" + name + "=([^&#]*)";
  var regex = new RegExp(regexS);
  var results = regex.exec(url);
  if (results == null)
    return "";
  else
    return results[1];
}

var defaultTags = new Array();
defaultTags['girlswhoswallow'] = "cum, swallow, blowjob, cum in mouth, cum swallow, cumshot, throat, sperm, semen, jizz, cum play, cum slut, cum whore, cum eating, cum fetish, spunk, cum drinking, oral, orgasm, oral sex, oral creampie, mouth cumshot, mouth creampie, cum on tongue, cum swap, cumplay, mouthful, swallow cum";
defaultTags['boundtightly'] = "tied, bondage, bdsm, master, slave, pet, pet play, bound, d/s, fetish, bound, rope";
defaultTags['analgirls'] = "anal, gape, ass, bubble butt, booty, butt, girls, ass play, anal play, butt fuck, anal girls, anal sex, ass lick, asshole, bum, butthole, buttsex, ass fetish, gape lover, gaping";
defaultTags['whitehotsexy'] = "sexy, hot, damn, beauty, beautiful, sex, gorgeous, girls, women, skin, nude, fine";
defaultTags['lesbianstepsisters'] = "lesbian, lesbian love, girls kissing, queer, girls, lesbian stepsister, stepsister, girl love, lesbian fantasy";

function addSigAndTags(onFinish)
{
  console.log("addSigAndTags " + g_lastSeenMCEframe + " " + g_blogLink + " " + g_blogName);
  if (!g_lastSeenMCEframe || !g_blogLink || !g_blogName)
  {
    if (onFinish)
      onFinish();
    return;
  }

  //var sig = "<p>- <a href=\"" + g_blogLink + "\">" + g_blogName + "</a>";
  var sig = "<p>";
  if (g_sourceBlogName)
  {
    //sig += " &#8651; " + g_sourceBlogName + "<small>";
    sig += "<small>";
    if (g_blogName == 'yourblog')
    {
      var choices = [""];
      var choice = shuffleArray(choices)[0];
      sig += choice;
    }
    sig + "</small>";
  }
  sig += "</p>";

  // ** No more sigs **
  //if (g_lastSeenMCEframe
  //  && /\S/.test(g_lastSeenMCEframe.contentWindow.document.body.innerHTML))
  //  g_lastSeenMCEframe.contentWindow.document.body.innerHTML += sig;

  if (!(g_blogName in defaultTags))
  {
    if (onFinish)
      onFinish();
    return;
  }

  var tag = $(TAG_EDITOR);
  var tagSpan = (tag.length)? tag.find("span") : null;
  var tagGhost = $(TAG_CONTAINER).find("ghost");
  var numTags = $(TAG_LABELS).length;
  if (tag.length && numTags == 0)
  {
    //console.log("NO TAGS!!!!! READY FOR INJECT!");
    var selectTags = shuffleArray(defaultTags[g_blogName].split(","));

    var tagsToInject = [];
    for (var ti=0; ti < selectTags.length && ti < 5; ti++)
      tagsToInject.push(selectTags[ti]);
    var NULLTAG = ",,,";
    tagsToInject.push(NULLTAG);

    var timer = setInterval(function() {
      var tag = tagsToInject.shift();

      $(TAG_CONTAINER).trigger("click");

      if (tag == NULLTAG)
      {
        clearInterval(timer);
        if (onFinish)
          onFinish();
        return;
      }

      //console.log("ANDBG adding tag " + tag);
      $(TAG_CONTAINER).find("span").html(tag);

      $(TAG_EDITOR).blur();
    }, 100);
  }
  else
  {
    if (onFinish)
      onFinish();
  }
}

function nukeLameNotes()
{
  var feed = document.getElementById("ui_activity_feed");
  if (feed)
  {
    $('.ui_note').each(function() {
      var note = this;
      var html = note.innerHTML;
      if (html.indexOf("and added") == -1
          /*&& html.indexOf("started following") == -1*/)
      {
        note.style.display = "none";
        note.parentNode.removeChild(note);
        delete note;
        note = null;
      }
    });
  }
}

/**
 * Randomize array element order in-place.
 * Using Fisher-Yates shuffle algorithm.
 */
function shuffleArray(array) {
    for (var i = array.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

window.onscroll = function (e)
{
  if (isActivity() || isDash() || isReblogging())
    restartPoller();
}

$(document).click(function(e) {
  if (isDash() || isReblogging())
    restartPoller();
});

var g_lastAutoPostTime = null;
function autoPostNowIfQueueFull()
{
  if (!g_autoPostWhenQueueFull)
    return;

  var createPostButton = $(CREATE_POST_BUTTON);
  if (!createPostButton.length)
    return;

  if (!hasQueueFullMessage())
    return;

  var now = Date.now();
  if (g_lastAutoPostTime
    && g_lastAutoPostTime + 5000 > now)
    return; // too soon

  g_lastAutoPostTime = now;

  selectPostAction(0);
  createPostButton.text("Auto-post");
  createPostButton.click();
}

function clickCreatePostButton(buttonNewName)
{
  var createPostButton = $(CREATE_POST_BUTTON);
  if (!createPostButton.length)
    return;

  if (buttonNewName)
    createPostButton.text(buttonNewName);

  createPostButton.click();
}

function clickQueue()
{
  selectPostAction(1);
  addSigAndTags(function() {
    clickCreatePostButton();
  });
}

function ObjToSource(o) {
    if (!o) return 'null';
    var k="",na=typeof(o.length)=="undefined"?1:0,str="";
    for(var p in o){
        try {
          var test = o[p];
        }
        catch(e) {
          continue;
        }
        if (na) k = "'"+p+ "':";
        if (typeof o[p] == "string") str += k + "'" + o[p]+"',";
        else if (typeof o[p] == "object") str += k + ObjToSource(o[p])+",";
        else str += k + o[p] + ",";
    }
    if (na) return "{"+str.slice(0,-1)+"}";
    else return "["+str.slice(0,-1)+"]";
}

function isCreatePostDialogOpen()
{
  var activeElement = $(document.activeElement);
  if (!activeElement.length)
    return false;

  var firstDiv = activeElement.children("div:first-child");
  if (!firstDiv)
    return false;

  if (firstDiv.attr('class') == 'ui_dialog_lock');
    return true;

  return false;
}

function hasQueueFullMessage()
{
  var errorMessage = $(".post-form--error-bar");
  if (errorMessage.text().indexOf(
        "Can't queue more") != -1)
    return true;

  return false;
}

function openBestOf(myBlog, blog, days, newTab)
{
  chrome.runtime.sendMessage(
    // tell background script to open bestof page
    {
      action: "bestof",
      blog: blog,
      myBlog: myBlog,
      days: days,
      newTab: newTab
    },
    function(response)
    {
      console.log(response.msg);
    });
}

function getInputSnapshot()
{
  var snap = "";

  if ($(CAPTION_EDITOR).length)
    snap += $(CAPTION_EDITOR).text();

  if ($(TAG_EDITOR).length)
  {
    snap += $(TAG_EDITOR).text();
    snap += $(TAG_LABELS).length.toString();
  }

  return snap;
}

function isInputFocused()
{
  //console.log($("*:focus"));

  if ($(document.activeElement).is("div.editor.editor-richtext"))
    return true;

  if ($(document.activeElement).is("div.editor.editor-plaintext"))
    return true;

  if ($(document.activeElement).is("textarea"))
    return true;

  if ($(document.activeElement).is("input"))
    return true;

  return false;
}

var g_lastKeyDowns = []; // set by onkeydown below
var g_lastKeyDownTimer = null;
function addLastKeyDownTimeout(unicode) {
  g_lastKeyDowns.push(unicode);

  if (g_lastKeyDownTimer)
    clearInterval(g_lastKeyDownTimer);

  g_lastKeyDownTimer = setTimeout(function() {
    g_lastKeyDowns = [];
    g_lastKeyDownTimer = null;
  }, 1000);
}
function lastKeyWasDoubleTapped() {
  var len = g_lastKeyDowns.length;

  if (len > 1
    && g_lastKeyDowns[len-1] == g_lastKeyDowns[len-2])
    return true;

  return false;
}

document.onkeydown=function(e)
{
  if (isActivity())
    restartPoller();

  if (isInputFocused())
    return; // we are in an input field - don't fire any hotkeys

  if (e.ctrlKey)
  {
    // don't execute any hotkeys if ctrl key is pressed
    return;
  }

  var unicode = e.keyCode? e.keyCode : e.charCode;
  console.log(unicode);
  addLastKeyDownTimeout(unicode);

  if (unicode == 82 && !isDash()) // r
  {
    /*
     * Bind r key to reblog from post page
     */
    var ctrl = document.getElementById('tumblr_controls');
    if (ctrl)
    {
      var url = ctrl.getAttribute('src');
      var pid  = getParam(url, 'pid');
      var rk  = getParam(url, 'rk');
      var redirectUrl = getParam(url, 'url') + 'post%2F' + pid;
      window.location.href = "https://www.tumblr.com/reblog/" + pid + "/" + rk + '?redirect_to=' + redirectUrl;
    }
    else
    {
      var iframe = $("iframe.tmblr-iframe--desktop-logged-in-controls");
      if (!iframe.length)
        iframe = $("iframe.tmblr-iframe--unified-controls");

      var iframeSrc = iframe.attr('src');
      $.ajax({
        url: iframeSrc
      }).done(function(html) {
        var lines = html.split('\n');
        var reblogLine = null;
        for (var li=0; li < lines.length && reblogLine == null; li++)
          if (lines[li].indexOf("reblogUrl") != -1)
            reblogLine = lines[li];

        if (!reblogLine)
          return;

        var startIdx = reblogLine.indexOf("reblogUrl");
        reblogLine = reblogLine.slice(startIdx);
        var endIdx = reblogLine.indexOf("show");
        reblogLine = reblogLine.slice(0, endIdx);
        var words = reblogLine.split("&quot;");
        if (words.length < 3)
          return;

        var reblogUrl = words[2];
        var reblogParams = reblogUrl.split("\\/");
        if (reblogParams.length < 6)
          return;

        var pid  = reblogParams[4];
        var rk  = reblogParams[5];
        var redirectUrl = encodeURIComponent(window.location.href);
        window.location.href = "https://www.tumblr.com/reblog/" + pid + "/" + rk + '?redirect_to=' + redirectUrl;
      });
    }
  }

  //if (unicode == 76 && !isDash()) // l
  //{
  //  /*
  //   * Bind l key to reblog from post page
  //   */
  //  var ctrl = document.getElementById('tumblr_controls');
  //  if (ctrl)
  //  {
  //    var url = ctrl.getAttribute('src');
  //    var pid  = getParam(url, 'pid');
  //    var sel = "like_iframe_" + pid;
  //    var selObj = document.getElementById(sel);
  //    if (selObj)
  //    {
  //      var selDoc = (selObj.contentWindow || selObj.contentDocument);
  //      if (selDoc.document)
  //        selDoc = selDoc.document;

  //      selDoc.getElementById('like').click();
  //    }
  //  }
  //}

  if (unicode >= 48 && unicode <= 57) // {1,2,3,4,5,6,7,8,9,0}
  {
    if (isCreatePostDialogOpen())
    {
      var blogIdx = (unicode - 48);
      selectBlog(blogIdx);
      e.preventDefault();

      if (lastKeyWasDoubleTapped())
        clickQueue();
    }
  }

  if (unicode == 68 && isDash() && g_devMode) // d
  {
    var incr = Math.floor((Math.random()*100)+1);
    var nextPageOffset = g_skipPageOffset + incr;
    window.location.href = "https://tumblr.com/dashboard/" + nextPageOffset;

    //document.getElementById("next_page_link").click();
  }
  if (unicode == 65 && isDash() && g_devMode) // a
  {
     document.getElementById("previous_page_link").click();
  }

  if (unicode == 113) // F2
  {
    clickQueue();
  }

  if (unicode == 84) // t
  {
    // ANDBG XXX
    // ANDBG XXX
    // ANDBG XXX
    // ANDBG XXX
    // ANDBG XXX
    e.preventDefault();
    addSigAndTags();
  }

  if (g_devMode && unicode == 13) // Enter
  {
    if (isCreatePostDialogOpen() && !isEditing()
      && !$(document.activeElement).is(CANCEL_POST_BUTTON))
    {
      addSigAndTags(function() {
        // focus + tap post button
        if ($(CREATE_POST_BUTTON).length
          && $(CREATE_POST_BUTTON + ':focus').length <= 0)
        {
          $(CREATE_POST_BUTTON).focus();
          clickCreatePostButton();
        }
      });
    }
  }

  if (unicode == 115 && !isDash()) // F4
  {
    window.location.href = 'http://' + document.location.hostname + '/archive';
  }

  if (unicode == 120 && !isDash()) // F9
  {
    var blogUrl = document.location.hostname;
    var blogName = blogUrl.split(".tumblr.com")[0];

    if (blogName && blogName.indexOf("www") == -1)
    {
      gaSendEvent('bestof', g_tumblrPrimaryBlog, blogName);
      openBestOf("", blogName, 8, false);
    }
  }

  //if (unicode == 82 && isDash()) // r
  //{
  //  // user is using VI keys and hitting 'r' to reblog
  //  restartPoller();
  //}

  if (unicode == 192) // `
  {
    if (isCreatePostDialogOpen() && !isEditing()
      && !$(document.activeElement).is(CANCEL_POST_BUTTON))
    {
      e.preventDefault();
      selectPostAction(0);
      addSigAndTags(function() {
        $(CREATE_POST_BUTTON).focus();
        clickCreatePostButton("Reblog");
      });
    }
  }

  if (unicode == 220 && isDash() && g_devMode) // \
  {
    openBestOf("girlswhoswallow", "_gws", 1, false);
  }
  if (unicode == 221 && isDash() && g_devMode) // ]
  {
    openBestOf("analgirls", "_ag", 1, false);
  }
  if (unicode == 219 && isDash() && g_devMode) // [
  {
    openBestOf("boundtightly", "_bt", 1, false);
  }
  if (unicode == 222 && isDash() && g_devMode) // '
  {
    openBestOf("whitehotsexy", "_whs", 1, false);
  }

  //if (g_devMode)
  //  console.log(unicode);
};

function gaSendEvent(category, action, label)
{
  chrome.runtime.sendMessage(
    // tell background script to save devMode state
    {
      action: "ga-event",
      gaCategory: category,
      gaAction: action,
      gaLabel: label
    }, function(response) { });
}

function gaSendUserBlogList() {
  var blogs = $(".tab_blog").map(function() {
    return $(this).attr('id');
  }).get();

  var userBlogs = new Array();
  for (var i=0; i < blogs.length; i++)
  {
    var blogName = blogs[i];
    if (blogName.indexOf('tab_blog_') == -1)
      continue;
    userBlogs.push(blogName.split("tab_blog_")[1]);
  }

  if (!userBlogs.length)
    return;

  var blogNames = userBlogs.join();
  g_tumblrPrimaryBlog = userBlogs[0];
  g_userBlogs = userBlogs;

  chrome.storage.sync.set({'primaryBlog': g_tumblrPrimaryBlog},
      function() {});
  chrome.storage.sync.set({'userBlogs': g_userBlogs.join(",")},
      function() {});

  gaSendEvent('tumblr', g_tumblrPrimaryBlog + '-blogs', blogNames);
}

function collectPostBlogsForAutoBestOf()
{
  if (!isDash() || !g_autoBestOf)
    return;

  $('a.post_info_link').each(function() {
    var buttonKey = 'str-bestof-scanned';
    if ($(this).data(buttonKey))
      return; // already modified

    $(this).data(buttonKey, '1');

    var reblogSource = $(this).text();

    if (!reblogSource)
      return;

    //console.log('queue ' + reblogSource);
    g_blogsToFindBestOf.push(reblogSource);
  });
}

function hideSponsoredPosts()
{
  if (!g_devMode)
    return;

  $(".yamplus-unit-container").each(function() {
    var post = $(this);
    //if (post.find('sponsored_label')
    //    && post.find('.sponsored_label').length)
    //{
    //  post.remove();
    //  post = null;
    //}
    post.remove();
    post = null;
  });
}

function hideUnderlay()
{
  if (!g_devMode)
    return;

  if (!isEditing() && !isReblogging())
    return;

  var url = document.URL;
  var redirect_to = getParam(url, 'redirect_to');

  if (!redirect_to || redirect_to.indexOf("dashboard") != -1)
  {
    // staying on this page
    // -- need underlay to return to right after posting
    return;
  }

  var leftColumn = $("#left_column");
  if (!leftColumn.length)
    return;
  if (leftColumn.data('str-hidden-img'))
    return;
  leftColumn.data('str-hidden-img', '1');

  leftColumn.hide();
  $("#right_column").hide();
  leftColumn.children("img").each(function() {
    $(this).attr("src", "");
    $(this).remove();
  });
}

function drawBestOfs(blog, posts)
{
  $('.post_container').each(function() {
    var postContainer = $(this);
    var reblogSource = postContainer.find('.share_social_button');
    var reblogSourceName = '';
    if (reblogSource && reblogSource.data('tumblelog-name'))
      reblogSourceName = reblogSource.data('tumblelog-name');

    if (reblogSourceName != blog)
      return;

    var visitedKey = 'str-bestof-suggestions-visited';
    if (postContainer.data(visitedKey))
    {
      //console.log("visited " + blog);
      return;
    }
    // mark post visited
    $(postContainer).data(visitedKey, '1');

    var postAvatar = postContainer.find(".post_avatar");
    if (!postAvatar.length)
    {
      //console.log("no avatar " + blog);
      return;
    }

    var seenUrls = [];
    var imageHtml = "";
    for (var i=0; i < posts.length; i++)
    {
      var post = posts[i];
      var photoUrl = utils_getFirstPhotoUrl(post, "s");
      photoUrl = photoUrl.replace("http:", "https:");

      if (seenUrls.indexOf(photoUrl) != -1)
        continue;
      seenUrls.push(photoUrl);

      var js = "onmouseover='this.style.opacity=1' onmouseout='this.style.opacity=0.5'";

      imageHtml += "<a title='" + post.note_count
        + " notes' href='" + post.post_url
        + "' target='_blank'>"
        + "<img class='super-reblog-post-bestof' " + js + " src='" + photoUrl +"'></a>";
    }

    var postAvatarParent = postAvatar.parent();
    var maxHeight = postContainer.height() - 64 - 21;
    var style="style='max-height: " + maxHeight + "px'";
    $("<div class='super-reblog-post-bestof-container' "
      + style
      + ">"
      + imageHtml + "</div>").hide()
      .appendTo(postAvatarParent).fadeIn();
  });
}

function getTotalFavBlogs()
{
  var numFavBlogs = 0;
  for (key in g_autoFavBlogs)
    if (g_autoFavBlogs.hasOwnProperty(key))
      numFavBlogs += getHashLength(g_autoFavBlogs[key]);

  return numFavBlogs;
}

function addMonsterToMenuBlog(blog)
{
  /*
   * FIXME tumblr's new account menu broke this feature
   */
  if (getHashLength(g_autoFavBlogs[blog]) < 20)
    return;

  $(document).ready(function() {
    var bestofId = 'super-reblog-menuitem-' + blog;
    if ($("#"+bestofId).length)
      return; // already added

    var menuId = '#menuitem-' + blog;
    if (!$(menuId).length)
      return;

    var numFavBlogs = getHashLength(g_autoFavBlogs[blog]);
    var title = "See new posts from "
      + blog
      + "'s " + numFavBlogs + " favorite sources";

    $("<div title=\""
      + title
      + "\" id='" + bestofId
      + "' class='super-reblog-menuitem-bestof-button'>"
      + "<img src='"
      + chrome.extension.getURL("img/icons/icon_48.png")
      + "'></div>").appendTo($(menuId));

    $("#"+bestofId).click(function() {
      var blogs = getFavBlogsList(blog);
      var blogStr = blogs.join(",");
      console.log('RAWR!' + blogStr);

      gaSendEvent('bestof', g_tumblrPrimaryBlog, "_menuautofav");
      openBestOf(blog, blogStr, 1, true);
      return false;
    });
  });
}

function addMonster()
{
  if (getTotalFavBlogs() < 20)
    return;

  $(document).ready(function() {
    if ($("#super-reblog-monster").length)
      return; // already added

    $("<div id='super-reblog-monster-tip'><div class='arrow-box'>Surprise! Click for today's best posts from your " + getTotalFavBlogs() + " favorite blogs. Thanks for rocking <em>Super Tumblr Reblog</em>!</div></div>").hide().appendTo($("body"));

    $("<div title=\"Click me\""
      + " id='super-reblog-monster'><img src='"
      + chrome.extension.getURL("img/icons/icon_48.png")
      + "'></div>").appendTo($("body"));

    $("#super-reblog-monster").mouseover(function() {
      $("#super-reblog-monster-tip").show();
    });
    $("#super-reblog-monster").mouseout(function() {
      $("#super-reblog-monster-tip").hide();
    });

    $("#super-reblog-monster").click(function() {
      var blogs = getAllFavBlogs();
      var blogStr = blogs.join(",");
      console.log('RAWR!' + blogStr);

      gaSendEvent('bestof', g_tumblrPrimaryBlog, "_autofav");
      openBestOf("", blogStr, 1, true);
    });
  }); // document.ready
}

function checkDoAutoClose()
{
  var url = document.URL;
  if (isPost() && g_devMode && getParam(url, 'str_autoclose'))
  {
    // received instruction to autoclose post after auto-reblogging
    // keep trying to close this tab until it is closed
    console.log("autoclose!");
    chrome.runtime.sendMessage(
      // ask background script to close this tab
      { action: "close-me" }, function () {});
  }
}

function checkDoAutoPost()
{
  var alreadyPosted = false;
  var hash = window.location.hash.substring(1);
  if (isReblogging() && g_devMode && hash)
  {
    setInterval(function() {
      restartPoller();

      if (!g_hasSetDefaultBlog || alreadyPosted)
        return;

      var mceFrame = $(CAPTION_EDITOR);
      if (mceFrame.length && mceFrame.html() !== "")
      {
        // still haven't cleared captions
        return;
      }

      // auto queue and close window
      var myBlogName = hash.split("_")[1];
      if (!myBlogName)
        return;

      console.log("autopost!");
      alreadyPosted = true;

      if (selectBlog(myBlogName))
        clickQueue();
    }, 1000);
  }
}

/***********************************
 * Main
 ***********************************/

$(document).ready(function() {
  if (isDash())
  {
    gaSendUserBlogList();
    collectPostBlogsForAutoBestOf();
  }
});

$(window).load(function() {
});

// main loop that checks for page changes
if (isReblogging() || isActivity() || isDash() || isEditing())
{
  restartPoller();
}

var g_blogsToFindBestOf = new Array();
var g_blogsPendingBestOf = new Array();
var g_blogsWithBestOf = new Object();
if (isDash())
{
  /*
   * background workhorse to fetch best posts.
   * seeded by collectPostBlogsForAutoBestOf()
   * needed for drawBestOfs()
   */

  setInterval(function() {
    if (!g_autoBestOf)
      return;

    // first, check oldest pending post
    if (g_blogsPendingBestOf.length)
    {
      var blogName = g_blogsPendingBestOf[0];
      chrome.runtime.sendMessage(
        // ask background script if result ready
        {
          action: "get-best-posts",
          blog: blogName
        },
        function(response) {
          if (response.posts)
          {
            //console.log("success "  + response.blog + " " + response.posts.length);
            // remove blog from "pending " and move to "found"
            var index = g_blogsPendingBestOf.indexOf(response.blog);
            if (index > -1)
              g_blogsPendingBestOf.splice(index, 1);

            g_blogsWithBestOf[response.blog] = response.posts;
            drawBestOfs(response.blog, response.posts);
          }
        }
      );
    }

    // now see if there are new blogs to process
    if (g_blogsToFindBestOf.length == 0)
      return;

    var blogName = g_blogsToFindBestOf.shift();
    while (g_blogsWithBestOf[blogName])
    {
      // already have the answer - no need to ask background
      // just use cached answer
      drawBestOfs(blogName, g_blogsWithBestOf[blogName]);

      if (g_blogsToFindBestOf.length == 0)
        return;

      blogName = g_blogsToFindBestOf.shift();
    }

    // move from 'to find' to 'pending' queue
    // wait for background.js to find the answer
    if (g_blogsPendingBestOf.indexOf(blogName) == -1)
      g_blogsPendingBestOf.push(blogName);

    chrome.runtime.sendMessage(
      // ask background script to find bestofs
      {
        action: "get-best-posts",
        blog: blogName
      },
      function(response) {
        // we'll check back later
      });
  }, 1000);
}
