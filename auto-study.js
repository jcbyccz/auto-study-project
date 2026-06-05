/**
 * 杭州人社学习平台 - 自动刷课脚本 v3.6
 *
 * v3.6 新增（去重）：
 *   1. ✅ 已学课程记录到 learned-courses.json，不再重复刷同一门课
 *   2. ✅ 选课时自动过滤已学课程，优先选未学的
 *   3. ✅ 当前页全部已学时自动翻页
 *
 * v3.5 修复（解决点击课程后卡死问题）：
 *   1. ✅ 移除 Promise.allSettled 导致的挂死（改用"点击后检查页面"模式）
 *   2. ✅ 5种点击策略逐个尝试（原生/force/内部元素/JS事件/span点击）
 *   3. ✅ 每次点击后主动扫描所有标签页，不再依赖 context.on('page')
 *   4. ✅ clickStartLearning 同步修复，不再用 context.on('page')
 * 
 * v3 修复：
 *   1. ✅ 登录持久化：使用 storageState，重启无需重新登录
 *   2. ✅ 不再重复弹页面：智能导航，不再每次循环 page.goto()
 *   3. ✅ 增强视频播放：支持更多播放器类型，多重策略自动播放
 * 
 * 适配流程：
 *   Course页面 → 选择"一般公需" → 点击查询 → 选课程 → 
 *   课程详情页点"立即学习" → 视频自动播放 → 弹窗确认在线 → 播完换下一课
 * 
 * 使用方式：
 *   cd ~/auto-study-project && node auto-study.js
 * 
 * 首次运行：浏览器弹出后手动登录，登录状态会自动保存
 * 后续运行：自动恢复登录，无需再次登录
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ============ 配置 ============
const CONFIG = {
  baseUrl: 'https://learning.hzrs.hangzhou.gov.cn',
  courseUrl: 'https://learning.hzrs.hangzhou.gov.cn/#/Course',
  // 每30秒模拟一次鼠标移动（防挂机检测）
  activityInterval: 30,
  // 每6秒检查一次视频状态和弹窗
  checkInterval: 6,
  // 视频卡住超时（秒）
  videoStuckTimeout: 300,
  headless: false,
  // 课程关键词偏好（计算机/软件开发相关，优先选这些课）
  preferKeywords: [
    '计算机', '软件', '信息技术', 'IT', '互联网', '数字化', '人工智能', 'AI',
    '大数据', '云计算', '网络安全', '信息安全', '数据', '智能', '编程',
    '电子商务', '物联网', '区块链', '5G', '信息化', '开发', '算法',
    '机器学习', '深度学习', '前端', '后端', '全栈', '架构',
  ],
  // 也要学的通用课程关键词
  generalKeywords: [
    '创新', '知识产权', '专利', '职业道德', '法律', '法规', '标准',
    '管理', '沟通', '协作', '团队', '项目管理', '经济', '金融',
  ],
  // 已学课程记录文件（去重用）
  learnedCoursesFile: path.join(process.env.HOME, 'auto-study-project', 'learned-courses.json'),
};

// ============ 全局状态 ============
let videoStuckCounter = 0;
let lastProgress = -1;
let completedCourses = 0;
let totalStudyHours = 0;
// 去重：已学课程名字集合（从 learned-courses.json 加载）
let learnedCourseNames = new Set();
// 去重：已学课程完整记录（含日期）
let learnedCourses = [];
let currentCourseName = '';
let logFile = null;

function sleep(sec) {
  return new Promise(r => setTimeout(r, sec * 1000));
}

function fmt(sec) {
  if (!sec || isNaN(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function log(msg) {
  const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = `[${now}] ${msg}`;
  console.log(line);
  if (logFile) {
    fs.appendFileSync(logFile, line + '\n');
  }
}

// 计算课程的相关性分数
function getRelevanceScore(text) {
  let score = 0;
  const lower = text.toLowerCase();
  for (const kw of CONFIG.preferKeywords) {
    if (lower.includes(kw.toLowerCase())) score += 10;
  }
  for (const kw of CONFIG.generalKeywords) {
    if (lower.includes(kw.toLowerCase())) score += 3;
  }
  return score;
}

// ============ 去重：已学课程管理 ============
function loadLearnedCourses() {
  const filePath = CONFIG.learnedCoursesFile;
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(data)) {
        learnedCourses = data;
        learnedCourseNames.clear();
        data.forEach(item => {
          const name = typeof item === 'string' ? item : item.name;
          if (name) learnedCourseNames.add(name);
        });
        log(`[去重] 已加载 ${learnedCourseNames.size} 门已学课程记录`);
      }
    } else {
      learnedCourses = [];
      fs.writeFileSync(filePath, JSON.stringify([], null, 2));
      log('[去重] 新建已学课程记录文件');
    }
  } catch (e) {
    log(`[去重] 加载已学课程失败: ${e.message}`);
    learnedCourses = [];
  }
}

function saveLearnedCourse(courseName) {
  if (!courseName || learnedCourseNames.has(courseName)) return;

  const filePath = CONFIG.learnedCoursesFile;
  const now = new Date().toISOString().split('T')[0];

  learnedCourseNames.add(courseName);
  learnedCourses.push({
    name: courseName,
    date: now,
    timestamp: Date.now(),
  });

  try {
    fs.writeFileSync(filePath, JSON.stringify(learnedCourses, null, 2));
    log(`[去重] ✅ 已保存新课程: ${courseName}`);
  } catch (e) {
    log(`[去重] 保存课程失败: ${e.message}`);
  }
}

// ============ 弹窗处理（核心！在线确认弹窗） ============
async function handlePopups(page) {
  try {
    // 1. 检查是否有可见的弹窗/遮罩层
    const hasOverlay = await page.evaluate(() => {
      const overlays = document.querySelectorAll(
        '.el-overlay, .v-overlay, .modal-backdrop, .el-dialog__wrapper, ' +
        '[class*="mask"]:not([style*="display: none"]), [class*="dialog"]:not([style*="display: none"])'
      );
      for (const o of overlays) {
        const style = window.getComputedStyle(o);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return true;
        }
      }
      return false;
    });

    if (!hasOverlay) return false;

    // 2. 有弹窗，尝试点击确认按钮
    const popupSelectors = [
      // Element UI 弹窗确认按钮（最常见）
      '.el-message-box__btns .el-button--primary',
      '.el-message-box__btns button:first-child',
      '.el-dialog__footer .el-button--primary',
      // 通用确认按钮
      'button:has-text("确认")',
      'button:has-text("确定")',
      'button:has-text("继续")',
      'button:has-text("继续学习")',
      'button:has-text("我知道了")',
      'a:has-text("确认")',
      'a:has-text("确定")',
      // Ant Design
      '.ant-btn-primary',
      '.ant-modal-confirm-btns .ant-btn-primary',
    ];

    for (const sel of popupSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          log(`[弹窗✅] 自动点击: ${sel}`);
          await sleep(1);
          return true;
        }
      } catch {}
    }

    // 3. 如果弹窗中有任意按钮，尝试点击
    try {
      const anyVisibleBtn = await page.evaluate(() => {
        const dialog = document.querySelector(
          '.el-message-box, .el-dialog, .ant-modal, [class*="dialog"]:not([style*="display: none"])'
        );
        if (!dialog) return null;
        const btns = dialog.querySelectorAll('button');
        for (const btn of btns) {
          if (btn.offsetWidth > 0) {
            btn.click();
            return btn.textContent.trim();
          }
        }
        return null;
      });
      if (anyVisibleBtn) {
        log(`[弹窗✅] 点击弹窗按钮: ${anyVisibleBtn}`);
        await sleep(1);
        return true;
      }
    } catch {}

    return false;
  } catch {
    return false;
  }
}

// ============ 模拟活跃（防挂机检测） ============
async function simulateActivity(page) {
  try {
    const x = 300 + Math.random() * 600;
    const y = 200 + Math.random() * 400;
    await page.mouse.move(x, y);
    // 偶尔滚动一下页面
    if (Math.random() > 0.7) {
      await page.mouse.wheel(0, Math.random() > 0.5 ? 100 : -100);
    }
  } catch {}
}

// ============ 视频操作（v3 增强版） ============
async function getVideoInfo(page) {
  return page.evaluate(() => {
    // 查找所有 video 元素
    const videos = document.querySelectorAll('video');
    if (videos.length === 0) return null;
    
    // 取第一个可见的 video
    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return {
          paused: v.paused,
          ended: v.ended,
          currentTime: v.currentTime,
          duration: v.duration,
          readyState: v.readyState,
          networkState: v.networkState,
          src: v.src || v.querySelector('source')?.src || '',
        };
      }
    }
    return null;
  });
}

async function tryPlayVideo(page) {
  log('[播放] 尝试播放视频...');

  // 策略1：JS 直接调用 video.play()
  try {
    const played = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return 'no-video';
      if (!v.paused) return 'already-playing';
      
      // 设置属性
      v.muted = false;
      v.volume = 0.3;
      v.autoplay = true;
      
      const playPromise = v.play();
      if (playPromise) {
        return playPromise.then(() => 'played').catch(e => 'play-failed: ' + e.message);
      }
      return 'no-promise';
    });
    log(`[播放] JS play(): ${played}`);
    if (played === 'played' || played === 'already-playing') return true;
  } catch (e) {
    log(`[播放] JS play() 异常: ${e.message}`);
  }

  await sleep(1);

  // 策略2：点击页面中的播放按钮（多种播放器适配）
  const playBtnSelectors = [
    // 阿里播放器
    '.prism-big-play-btn', '.prism-play-btn',
    // video.js
    '.vjs-big-play-button', '.vjs-play-control.vjs-paused',
    // 西瓜播放器
    '.xgplayer-start', '.xgplayer-play-btn',
    // CKPlayer
    '.ckplayer-play',
    // 通用
    'button[aria-label="Play"]', 'button[aria-label="播放"]',
    '[class*="play-btn"]:not([class*="pause"])',
    '[class*="Play"]',
    // 视频区域双击
    '.video-wrapper', '.player-wrapper',
  ];

  for (const sel of playBtnSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        log(`[播放] 点击播放按钮: ${sel}`);
        await sleep(2);
        
        // 验证是否开始播放
        const info = await getVideoInfo(page);
        if (info && !info.paused) {
          log('[播放] ✅ 视频已开始播放');
          return true;
        }
      }
    } catch {}
  }

  // 策略3：点击 video 元素本身
  try {
    const videoEl = await page.$('video');
    if (videoEl) {
      await videoEl.click();
      log('[播放] 点击 video 元素');
      await sleep(2);
      
      const info = await getVideoInfo(page);
      if (info && !info.paused) return true;
    }
  } catch {}

  // 策略4：用 JS 模拟点击 video
  try {
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        v.dispatchEvent(new Event('play', { bubbles: true }));
      }
    });
    await sleep(2);
    const info = await getVideoInfo(page);
    if (info && !info.paused) return true;
  } catch {}

  // 策略5：静音播放（有些浏览器阻止有声音的自动播放）
  try {
    const played = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return false;
      v.muted = true;
      v.play().catch(() => {});
      return !v.paused;
    });
    if (played) {
      log('[播放] ✅ 静音播放成功，稍后取消静音');
      await sleep(3);
      // 取消静音
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (v) { v.muted = false; v.volume = 0.3; }
      });
      return true;
    }
  } catch {}

  log('[播放] ⚠️ 所有策略均未能播放视频');
  return false;
}

// ============ 检测当前页面类型 ============
async function detectPageType(page) {
  const url = page.url();
  
  if (url.includes('/#/class')) return 'video';
  if (url.includes('/#/CourseDetail')) return 'detail';
  if (url.includes('/#/Course')) return 'course';
  if (url.includes('learning.hzrs.hangzhou.gov.cn')) return 'site';
  return 'unknown';
}

// ============ 检测是否已登录 ============
async function isLoggedIn(page) {
  try {
    const result = await page.evaluate(() => {
      // 检查常见的已登录标志
      const indicators = [
        // 用户头像/名称
        '.user-info', '.user-name', '.avatar', '[class*="user"]',
        // 退出登录按钮
        'a:has-text("退出")', 'button:has-text("退出")',
        '[class*="logout"]', '[class*="sign-out"]',
        // 登录后才能看到的元素
        '.header-right', '.nav-user',
      ];
      for (const sel of indicators) {
        const el = document.querySelector(sel);
        if (el && el.offsetWidth > 0) return true;
      }
      // 如果页面有课程列表相关内容，说明已登录
      const courseEl = document.querySelector('.course-card, [class*="course"], .el-table');
      if (courseEl) return true;
      return false;
    });
    return result;
  } catch {
    return false;
  }
}

// ============ 智能导航（不重复弹页面） ============
async function navigateTo(page, targetUrl) {
  const currentUrl = page.url();
  
  // 如果已经在目标页面，不导航
  if (currentUrl.includes(new URL(targetUrl).hash)) {
    log('[导航] 已在目标页面，无需跳转');
    return;
  }
  
  // 如果在同一个 SPA 中，可以直接导航
  if (currentUrl.includes('learning.hzrs.hangzhou.gov.cn')) {
    log('[导航] SPA内导航...');
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2);
    return;
  }
  
  // 全新导航
  log('[导航] 打开页面...');
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(3);
}

// ============ 选课流程 ============
async function selectCourseCategory(page) {
  log('[选课] 选择"一般公需"分类...');

  try {
    // 先截图看看当前页面状态
    const pageType = await detectPageType(page);
    if (pageType !== 'course') {
      log('[选课] 不在课程页面，导航中...');
      await navigateTo(page, CONFIG.courseUrl);
    }

    // 策略1：使用 Element UI select 组件交互
    // 找到"课程类别"对应的 el-select 并点击打开
    const selectOpened = await page.evaluate(() => {
      // 查找所有 el-select 组件
      const selects = document.querySelectorAll('.el-select');
      for (let i = 0; i < selects.length; i++) {
        const input = selects[i].querySelector('.el-input__inner, input');
        if (input) {
          const placeholder = input.getAttribute('placeholder') || '';
          const value = input.value || '';
          // 第一个 select 通常是课程类别
          if (i === 0 || placeholder.includes('类别') || placeholder.includes('课程')) {
            input.click();
            return { index: i, placeholder, value };
          }
        }
      }
      return null;
    });

    if (selectOpened) {
      log(`[选课] 打开了第 ${selectOpened.index + 1} 个下拉框`);
      await sleep(1);

      // 在下拉选项中找"一般公需"
      const optionClicked = await page.evaluate(() => {
        const items = document.querySelectorAll('.el-select-dropdown__item');
        for (const item of items) {
          const text = item.textContent.trim();
          if (text.includes('一般公需')) {
            item.click();
            return text;
          }
        }
        return null;
      });

      if (optionClicked) {
        log(`[选课✅] 选中: ${optionClicked}`);
        await sleep(1);
        return true;
      } else {
        log('[选课] 下拉选项中未找到"一般公需"，列出所有选项...');
        const options = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('.el-select-dropdown__item'))
            .map(el => el.textContent.trim());
        });
        log(`[选课] 可选项: ${options.join(' | ')}`);
      }
    }

    // 策略2：直接用 Playwright 点击
    try {
      // 找课程类别区域
      const filterArea = await page.$('[class*="filter"], [class*="search"], .el-form');
      if (filterArea) {
        // 点击第一个 select 的 input
        const firstSelectInput = await filterArea.$('.el-select .el-input__inner');
        if (firstSelectInput) {
          await firstSelectInput.click();
          await sleep(1);
          
          const opt = await page.$('.el-select-dropdown__item:has-text("一般公需")');
          if (opt) {
            await opt.click();
            log('[选课✅] 通过 Playwright 选中: 一般公需');
            await sleep(1);
            return true;
          }
        }
      }
    } catch {}

    // 策略3：使用 combobox role
    try {
      const combobox = await page.$('[role="combobox"]');
      if (combobox) {
        await combobox.click();
        await sleep(1);
        const opt = await page.$('text=一般公需');
        if (opt) {
          await opt.click();
          log('[选课✅] 通过 combobox 选中: 一般公需');
          await sleep(1);
          return true;
        }
      }
    } catch {}

    log('[选课] ⚠️ 未能自动选择课程类别，可能需要手动选择');
    return false;
  } catch (e) {
    log(`[选课] 出错: ${e.message}`);
    return false;
  }
}

async function searchCourses(page) {
  log('[搜索] 点击查询...');
  try {
    // 尝试多种查询按钮选择器
    const btnSelectors = [
      'button:has-text("查询")',
      'button:has-text("搜索")',
      'button:has-text("搜 索")',
      '.el-button--primary',
      '[class*="search"] button',
    ];

    for (const sel of btnSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          await btn.click();
          log(`[搜索] 点击: ${sel}`);
          await sleep(3);
          return true;
        }
      } catch {}
    }

    // 备用：按回车
    await page.keyboard.press('Enter');
    log('[搜索] 按回车查询');
    await sleep(3);
    return true;
  } catch (e) {
    log(`[搜索] 出错: ${e.message}`);
    return false;
  }
}

async function pickBestCourse(page, context) {
  log('[选课] 从课程列表中选择最合适的课程...');

  try {
    // ====== 第一步：深度 DOM 探测，找到课程元素 ======
    const courses = await page.evaluate(() => {
      const items = [];

      // 策略1：尝试已知课程卡片选择器
      const cardSelectors = [
        '.course-card', '.course-item', '[class*="course-card"]',
        '[class*="courseItem"]', '.el-card', '.list-item',
        '.course-list > div', '.course-list > a',
        '[class*="course"] [class*="item"]',
        '.el-table__row',
      ];

      let cards = [];
      for (const sel of cardSelectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          cards = Array.from(found);
          break;
        }
      }

      // 策略2：如果已知选择器都没找到，用文本特征搜索
      // 课程文本特征：包含"讲师："或"时长："和"学时："
      if (cards.length === 0) {
        // 遍历所有 div/section/article/li，找包含课程文本特征的
        const allDivs = document.querySelectorAll('div, section, article, li, a, span');
        const courseElements = new Set();

        for (const el of allDivs) {
          const text = el.textContent || '';
          // 课程文本特征：同时包含"讲师"和"学时"
          if (text.includes('讲师') && text.includes('学时')) {
            // 检查是否是最小包含单元（避免父元素包含多个课程时被重复选）
            const hasChildCourse = Array.from(el.children).some(
              child => child.textContent.includes('讲师') && child.textContent.includes('学时')
            );
            if (!hasChildCourse) {
              courseElements.add(el);
            }
          }
        }

        cards = Array.from(courseElements);
      }

      // 策略3：如果还是没找到，尝试更宽松的匹配
      if (cards.length === 0) {
        const allDivs = document.querySelectorAll('div, section, article, li');
        const courseElements = new Set();

        for (const el of allDivs) {
          const text = el.textContent || '';
          // 更宽松：包含"时长"和"分钟"
          if (text.includes('分钟') && (text.includes('类型') || text.includes('公需'))) {
            const hasChildCourse = Array.from(el.children).some(
              child => child.textContent.includes('分钟') && child.textContent.includes('公需')
            );
            if (!hasChildCourse) {
              courseElements.add(el);
            }
          }
        }

        cards = Array.from(courseElements);
      }

      cards.forEach((card, index) => {
        const text = card.textContent || '';
        const link = card.querySelector('a[href]');
        const href = link ? link.getAttribute('href') : null;
        const onclick = card.getAttribute('onclick') || '';
        const cursor = window.getComputedStyle(card).cursor;

        items.push({
          index,
          text: text.substring(0, 500),
          href,
          onclick,
          tagName: card.tagName,
          className: card.className,
          id: card.id || '',
          isClickable: cursor === 'pointer' || !!onclick || !!href || card.tagName === 'A',
          rect: {
            top: card.getBoundingClientRect().top,
            left: card.getBoundingClientRect().left,
            width: card.getBoundingClientRect().width,
            height: card.getBoundingClientRect().height,
          },
        });
      });

      // 按页面位置排序（从上到下）
      items.sort((a, b) => a.rect.top - b.rect.top);
      // 重新编号
      items.forEach((item, i) => item.index = i);

      return items;
    });

    if (courses.length === 0) {
      log('[选课] ⚠️ 未找到课程元素');
      // 最终调试：输出完整页面结构
      const debugInfo = await page.evaluate(() => {
        // 输出页面中所有有内容的 div 的 className 和文本前 100 字
        const divs = document.querySelectorAll('div');
        const interesting = [];
        for (const d of divs) {
          const text = d.textContent.trim();
          if (text.includes('学时') || text.includes('讲师')) {
            interesting.push({
              tag: d.tagName,
              class: d.className,
              id: d.id,
              childCount: d.children.length,
              textPreview: text.substring(0, 150),
            });
          }
        }
        return interesting.slice(0, 10);
      });
      log(`[调试] 含"学时/讲师"的元素: ${JSON.stringify(debugInfo, null, 2)}`);
      return null;
    }

    log(`[选课] 找到 ${courses.length} 个课程`);

    // 打印课程列表
    for (let i = 0; i < Math.min(courses.length, 5); i++) {
      const c = courses[i];
      log(`  [#${i}] ${c.text.substring(0, 80).replace(/\n/g, ' ')} | click=${c.isClickable} | ${c.tagName}.${c.className.substring(0, 30)}`);
    }

    // ====== 第二步：按相关性排序选课 ======
    let scored = courses.map(c => ({
      ...c,
      score: getRelevanceScore(c.text),
    })).sort((a, b) => b.score - a.score);

    // 打印排序结果
    for (let i = 0; i < Math.min(3, scored.length); i++) {
      const s = scored[i];
      log(`  [排序#${i}] 相关性:${s.score} | ${s.text.substring(0, 60).replace(/\n/g, ' ')}`);
    }

    // ====== 第二步.5：过滤已学课程（去重）======
    const beforeFilter = scored.length;
    scored = scored.filter(c => {
      const nameMatch = c.text.match(/\]([^\n讲师]+)/);
      const name = nameMatch ? nameMatch[1].trim() : c.text.substring(0, 60).replace(/\n/g, ' ');
      return !learnedCourseNames.has(name);
    });

    if (scored.length < beforeFilter) {
      log(`[去重] 过滤掉 ${beforeFilter - scored.length} 门已学课程，剩余 ${scored.length} 门可选`);
    }

    if (scored.length === 0) {
      log('[选课] 当前页课程全部已学，尝试翻页...');
      const nextBtn = await page.$('button:has-text("下一页"), .el-pagination .btn-next, .btn-next');
      if (nextBtn) {
        await nextBtn.click();
        await sleep(3);
        return pickBestCourse(page, context);
      }
      log('[选课] 没有下一页了');
      return null;
    }

    // ====== 第三步：选第一个未看过的课程并点击 ======
    for (const course of scored) {
      // 从课程文本提取课程名（[分类]名称 的格式）
      const nameMatch = course.text.match(/\]([^\n讲师]+)/);
      currentCourseName = nameMatch ? nameMatch[1].trim() : course.text.substring(0, 60).replace(/\n/g, ' ');

      // 再次检查去重（双重保险）
      if (learnedCourseNames.has(currentCourseName)) {
        log(`[去重] 跳过已学: ${currentCourseName}`);
        continue;
      }

      log(`[选课✅] 选中: ${currentCourseName} (相关性:${course.score})`);

      // 尝试点击课程
      const result = await clickCourseElement(page, context, course);
      if (result && result.page) {
        // 成功跳转（可能是当前页面导航，也可能是新标签页）
        page = result.page; // 更新 page 指向详情页
        const pageType = await detectPageType(page);
        log(`[选课✅] 已到达${pageType === 'detail' ? '详情' : pageType === 'video' ? '视频' : '其他'}页`);
        return { course, detailPage: page, mainPage: result.mainPage };
      }

      log(`[选课] 点击失败，尝试下一个课程...`);
    }

    // 所有课程都看过了，翻页
    log('[选课] 当前页课程已全部观看，翻页...');
    const nextBtn = await page.$('button:has-text("下一页"), .el-pagination .btn-next, .btn-next');
    if (nextBtn) {
      await nextBtn.click();
      await sleep(3);
      return pickBestCourse(page, context);
    }

    return null;
  } catch (e) {
    log(`[选课] 出错: ${e.message}`);
    return null;
  }
}

// 点击课程 — 核心：监听新标签页事件 (v3.5 重写)
async function clickCourseElement(page, context, course) {
  const courseName = currentCourseName;
  const pagesBefore = new Set(context.pages().map(p => p.url()));

  // ====== 多策略点击 ======
  const clickStrategies = [
    {
      name: 'Playwright原生点击itemBox',
      fn: async () => {
        const itemBoxes = await page.$$('.itemBox');
        log(`[选课] 找到 ${itemBoxes.length} 个 .itemBox`);
        for (let i = 0; i < itemBoxes.length; i++) {
          const boxText = await itemBoxes[i].textContent().catch(() => '');
          if (boxText.includes(courseName)) {
            // 先滚动到可见区域
            await itemBoxes[i].scrollIntoViewIfNeeded().catch(() => {});
            await sleep(0.3);
            await itemBoxes[i].click({ timeout: 5000 });
            log(`[选课] 点击 .itemBox[${i}]`);
            return true;
          }
        }
        return false;
      }
    },
    {
      name: 'force点击itemBox',
      fn: async () => {
        const itemBoxes = await page.$$('.itemBox');
        for (let i = 0; i < itemBoxes.length; i++) {
          const boxText = await itemBoxes[i].textContent().catch(() => '');
          if (boxText.includes(courseName)) {
            await itemBoxes[i].scrollIntoViewIfNeeded().catch(() => {});
            await sleep(0.3);
            await itemBoxes[i].click({ force: true, timeout: 5000 });
            log(`[选课] force点击 .itemBox[${i}]`);
            return true;
          }
        }
        return false;
      }
    },
    {
      name: '点击itemBox内img+文字div',
      fn: async () => {
        const itemBoxes = await page.$$('.itemBox');
        for (let i = 0; i < itemBoxes.length; i++) {
          const boxText = await itemBoxes[i].textContent().catch(() => '');
          if (boxText.includes(courseName)) {
            // 尝试点击内部元素（img 或 文字区域 div）
            const innerDivs = await itemBoxes[i].$$('div');
            if (innerDivs.length > 0) {
              // 点击第二个子div（文字区域）
              await innerDivs[innerDivs.length > 1 ? 1 : 0].scrollIntoViewIfNeeded().catch(() => {});
              await sleep(0.3);
              await innerDivs[innerDivs.length > 1 ? 1 : 0].click({ timeout: 5000 });
              log(`[选课] 点击 .itemBox[${i}] 内部文字div`);
              return true;
            }
          }
        }
        return false;
      }
    },
    {
      name: 'JS dispatchEvent点击',
      fn: async () => {
        const clicked = await page.evaluate((searchName) => {
          const boxes = document.querySelectorAll('.itemBox');
          for (const box of boxes) {
            if (!box.textContent.includes(searchName)) continue;
            box.scrollIntoView({ behavior: 'instant', block: 'center' });
            // 创建并派发真实的鼠标事件
            const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
            for (const eventType of events) {
              box.dispatchEvent(new MouseEvent(eventType, {
                bubbles: true, cancelable: true, view: window,
              }));
            }
            return true;
          }
          return false;
        }, courseName);
        if (clicked) log('[选课] JS dispatchEvent 点击');
        return clicked;
      }
    },
    {
      name: '点击课程名span',
      fn: async () => {
        // itemBox 结构: <div class="itemBox"><div><img/></div><div><div class="Line0">...</div><div class="Line"><span>课程名</span></div></div></div>
        const spans = await page.$$('.itemBox .Line span');
        for (const span of spans) {
          const text = await span.textContent().catch(() => '');
          if (text.includes(courseName)) {
            await span.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(0.3);
            await span.click({ timeout: 5000 });
            log(`[选课] 点击课程名span: ${text.substring(0, 30)}`);
            return true;
          }
        }
        return false;
      }
    },
  ];

  // ====== 逐策略尝试，每次点击后等5秒检查结果 ======
  for (const strategy of clickStrategies) {
    try {
      log(`[选课] 尝试策略: ${strategy.name}`);
      const clicked = await strategy.fn();
      if (!clicked) {
        log(`[选课] 策略未找到目标元素`);
        continue;
      }

      // 等待5秒，看是否产生了新标签页或页面导航
      log('[选课] 点击完成，等待5秒检查结果...');
      await sleep(5);

      // 检查方式1：当前页 URL 是否变化
      const pageType = await detectPageType(page);
      if (pageType === 'detail' || pageType === 'video') {
        log(`[选课✅] 当前页已导航到${pageType}页: ${page.url()}`);
        return { page, mainPage: null };
      }

      // 检查方式2：是否有新标签页打开
      const allPagesNow = context.pages();
      for (const p of allPagesNow) {
        if (p.isClosed()) continue;
        if (pagesBefore.has(p.url())) continue; // 之前就存在的页面
        const pUrl = p.url();
        if (pUrl.includes('learning.hzrs.hangzhou.gov.cn')) {
          log(`[选课✅] 新标签页已打开: ${pUrl}`);
          await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          return { page: p, mainPage: page };
        }
      }

      // 检查方式3：所有标签页中找详情页/视频页（可能URL相同但hash不同）
      for (const p of allPagesNow) {
        if (p.isClosed() || p === page) continue;
        const pType = await detectPageType(p);
        if (pType === 'detail' || pType === 'video') {
          log(`[选课✅] 在其他标签页找到${pType}页: ${p.url()}`);
          return { page: p, mainPage: page };
        }
      }

      log(`[选课] 策略 ${strategy.name} 点击后无跳转，尝试下一策略`);
    } catch (e) {
      log(`[选课] 策略 ${strategy.name} 异常: ${e.message}`);
    }
  }

  // ====== 兜底策略：Vue 实例探索获取 courseid，直接构造 URL ======
  log('[选课] 所有点击策略均未跳转，尝试从Vue数据提取courseid...');
  try {
    const courseInfo = await page.evaluate((searchName) => {
      const boxes = document.querySelectorAll('.itemBox');
      for (const box of boxes) {
        if (!box.textContent.includes(searchName)) continue;

        // 尝试从 Vue 实例获取课程数据
        const vueKeys = Object.keys(box).filter(k => k.startsWith('__vue'));
        if (vueKeys.length > 0) {
          const vm = box[vueKeys[0]];
          if (vm) {
            const vmData = {};
            for (const key of Object.keys(vm)) {
              if (key.startsWith('_') || key.startsWith('$')) continue;
              try {
                const val = vm[key];
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                  if (val.id || val.courseid || val.courseId) {
                    vmData[key] = JSON.stringify(val).substring(0, 500);
                  }
                }
              } catch {}
            }
            if (Object.keys(vmData).length > 0) return vmData;
          }
        }

        // 检查父元素
        let parent = box.parentElement;
        for (let depth = 0; depth < 8 && parent; depth++) {
          const parentKeys = Object.keys(parent).filter(k => k.startsWith('__vue'));
          if (parentKeys.length > 0) {
            const pvm = parent[parentKeys[0]];
            if (pvm) {
              const dataKeys = ['courses', 'courseList', 'list', 'courseData', 'items', 'dataList', 'tableData'];
              for (const dk of dataKeys) {
                if (pvm[dk] && Array.isArray(pvm[dk])) {
                  const found = pvm[dk].find(c => c.name && c.name.includes(searchName));
                  if (found) return { courseData: JSON.stringify(found).substring(0, 800) };
                }
              }
              for (const key of Object.keys(pvm)) {
                if (key.startsWith('_') || key.startsWith('$')) continue;
                try {
                  if (Array.isArray(pvm[key]) && pvm[key].length > 0) {
                    const first = pvm[key][0];
                    if (first && typeof first === 'object' && (first.id || first.courseid || first.name)) {
                      const found = pvm[key].find(c => c.name && c.name.includes(searchName));
                      if (found) return { [key]: JSON.stringify(found).substring(0, 800) };
                    }
                  }
                } catch {}
              }
            }
          }
          parent = parent.parentElement;
        }
      }
      return null;
    }, courseName);

    if (courseInfo) {
      log(`[选课] Vue数据: ${JSON.stringify(courseInfo).substring(0, 300)}`);
      const jsonStr = JSON.stringify(courseInfo);
      const idMatch = jsonStr.match(/(?:courseid|courseId|course_id|id)"?\s*[:=]\s"*(\d{4,})/i);
      if (idMatch) {
        const detailUrl = `${CONFIG.baseUrl}/#/CourseDetail?courseid=${idMatch[1]}`;
        log(`[选课] 提取到courseid=${idMatch[1]}，直接导航: ${detailUrl}`);
        await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await sleep(2);
        const pageType = await detectPageType(page);
        if (pageType === 'detail' || pageType === 'video') {
          log(`[选课✅] 直接导航成功`);
          return { page, mainPage: null };
        }
      }
    }
  } catch (e) {
    log(`[选课] Vue探索异常: ${e.message}`);
  }

  log('[选课] ⚠️ 所有点击策略均未能跳转到详情页');
  return null;
}

async function clickStartLearning(page, context) {
  log('[详情] 在课程详情页点击"立即学习"...');

  try {
    // 检查是否已在视频页面
    const pageType = await detectPageType(page);
    if (pageType === 'video') {
      log('[详情] 已在视频页面，无需点击"立即学习"');
      return true;
    }

    if (pageType !== 'detail') {
      log(`[详情] 当前不在详情页(=${pageType})，等待跳转...`);
      await sleep(3);
      const newType = await detectPageType(page);
      if (newType !== 'detail' && newType !== 'video') {
        log(`[详情] 页面类型仍为 ${newType}，无法点击`);
        return false;
      }
      if (newType === 'video') {
        log('[详情] 已跳转到视频页面');
        return true;
      }
    }

    // 等待详情页加载
    log('[详情] 等待详情页加载...');
    await sleep(3);

    // 按钮选择器
    const btnSelectors = [
      '.el-button--primary:has-text("立即学习")',
      'button.el-button--primary',
      'button:has-text("立即学习")',
      'a:has-text("立即学习")',
      'text=立即学习',
      '.el-button--primary:has-text("开始学习")',
      'button:has-text("开始学习")',
      'text=开始学习',
      '.el-button--primary:has-text("继续学习")',
      'button:has-text("继续学习")',
      'text=继续学习',
    ];

    // 重试机制
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const sel of btnSelectors) {
        try {
          const locator = page.locator(sel);
          const count = await locator.count();
          if (count > 0) {
            const isVisible = await locator.first().isVisible().catch(() => false);
            if (isVisible) {
              const pagesBefore = new Set(context.pages().map(p => p.url()));

              await locator.first().click();
              log(`[详情] Playwright点击: ${sel}`);

              // 等待5秒检查结果
              await sleep(5);

              // 检查当前页导航
              const afterType = await detectPageType(page);
              if (afterType === 'video') {
                log('[详情✅] 已跳转到视频页面');
                return true;
              }

              // 检查新标签页
              const allPagesNow = context.pages();
              for (const p of allPagesNow) {
                if (p.isClosed() || p === page) continue;
                const pUrl = p.url();
                // 之前不存在的页面，且是学习平台的
                if (!pagesBefore.has(pUrl) && pUrl.includes('learning.hzrs.hangzhou.gov.cn')) {
                  log(`[详情✅] 视频在新标签页打开: ${pUrl}`);
                  await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                  return true;
                }
                // 或者在任何标签页找到视频页
                if (pUrl.includes('/class')) {
                  log(`[详情✅] 在其他标签页找到视频页: ${pUrl}`);
                  return true;
                }
              }

              log(`[详情] 点击后页面类型: ${afterType}，无新标签页`);
            }
          }
        } catch {}
      }

      if (attempt < 2) {
        log(`[详情] 第${attempt + 1}次未找到按钮，等待3秒后重试...`);
        await sleep(3);
      }
    }

    log('[详情] ⚠️ 未找到"立即学习"按钮');

    // 调试：输出详情页按钮信息
    const debugBtns = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, .el-button, a');
      return Array.from(btns).filter(b => b.offsetWidth > 0).slice(0, 15).map(b => ({
        tag: b.tagName,
        class: b.className,
        text: b.textContent.trim().substring(0, 50),
        visible: b.offsetWidth > 0,
      }));
    });
    log(`[调试] 页面可见按钮: ${JSON.stringify(debugBtns)}`);

    return false;
  } catch (e) {
    log(`[详情] 出错: ${e.message}`);
    return false;
  }
}

// ============ 观看单个课程 ============
async function watchCurrentVideo(page) {
  log(`[观看] 开始观看: ${currentCourseName}`);

  // 等待视频页面加载
  await sleep(5);

  // 初始尝试播放
  let playAttempts = 0;
  let isPlaying = false;

  while (playAttempts < 5) {
    isPlaying = await tryPlayVideo(page);
    if (isPlaying) break;
    playAttempts++;
    log(`[播放] 第 ${playAttempts} 次尝试播放失败，${3}秒后重试...`);
    await sleep(3);
  }

  if (!isPlaying) {
    log('[播放] ⚠️ 多次尝试播放失败，可能需要手动点击播放');
    log('[播放] 脚本会继续监控，如果你手动点击播放后将自动继续');
  }

  // 设置活跃模拟定时器
  const activityTimer = setInterval(() => simulateActivity(page), CONFIG.activityInterval * 1000);

  let consecutiveNoVideo = 0;
  let statusLogCounter = 0;

  try {
    while (true) {
      // 1. 处理弹窗（每轮都检查，最重要！）
      await handlePopups(page);

      // 2. 获取视频状态
      const info = await getVideoInfo(page);

      if (info) {
        consecutiveNoVideo = 0;
        const pct = info.duration > 0 ? ((info.currentTime / info.duration) * 100).toFixed(1) : 0;
        const status = info.ended ? '✅结束' : (info.paused ? '⏸暂停' : '▶播放');

        // 每5次检查输出一次状态（减少日志刷屏）
        statusLogCounter++;
        if (statusLogCounter % 5 === 0 || info.ended || info.paused) {
          log(`[视频] ${fmt(info.currentTime)}/${fmt(info.duration)} | ${pct}% | ${status} | 已完成${completedCourses}课`);
        }

        // 视频暂停 → 播放
        if (info.paused && !info.ended) {
          log('[视频] 检测到暂停，重新播放...');
          await tryPlayVideo(page);
          await sleep(2);
        }

        // 卡住检测
        if (Math.abs(info.currentTime - lastProgress) < 0.5 && !info.paused && !info.ended) {
          videoStuckCounter++;
          if (videoStuckCounter > CONFIG.videoStuckTimeout / CONFIG.checkInterval) {
            log('[⚠️] 视频可能卡住，刷新页面...');
            await page.reload({ waitUntil: 'networkidle' });
            await sleep(5);
            await tryPlayVideo(page);
            videoStuckCounter = 0;
          }
        } else {
          videoStuckCounter = 0;
        }
        lastProgress = info.currentTime;

        // 视频播完！
        if (info.ended || (info.duration > 0 && info.currentTime >= info.duration - 2)) {
          completedCourses++;
          const hoursMatch = currentCourseName.match(/学时[：:](\d+\.?\d*)/);
          const hours = hoursMatch ? parseFloat(hoursMatch[1]) : 1;
          totalStudyHours += hours;

          // 保存到去重文件
          saveLearnedCourse(currentCourseName);

          log('');
          log('  ══════════════════════════════════════');
          log(`  ✅ 第${completedCourses}课完成！+${hours}学时 | 累计: ${totalStudyHours}学时`);
          log('  ══════════════════════════════════════');
          log('');

          clearInterval(activityTimer);
          lastProgress = -1;
          videoStuckCounter = 0;
          return true;
        }
      } else {
        consecutiveNoVideo++;
        if (consecutiveNoVideo > 15) {
          log('[⚠️] 长时间未检测到视频，可能页面异常');
          clearInterval(activityTimer);
          return false;
        }

        // 视频可能在加载
        if (consecutiveNoVideo % 3 === 1) {
          log('[等待] 视频加载中...');
          await tryPlayVideo(page);
        }
      }

      await sleep(CONFIG.checkInterval);
    }
  } catch (e) {
    log(`[观看] 异常: ${e.message}`);
    clearInterval(activityTimer);
    return false;
  }
}

// ============ 回到课程列表 ============
async function goBackToCourseList(page) {
  log('[返回] 回到课程列表...');

  try {
    // 优先用浏览器后退（SPA 内导航更快，不弹新页面）
    await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await sleep(2);

    const pageType = await detectPageType(page);
    if (pageType === 'course') {
      log('[返回] ✅ 已回到课程列表');
      return true;
    }

    // 如果后退没到课程页，再后退一步（从视频 → 详情 → 课程）
    if (pageType === 'detail') {
      await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await sleep(2);
      const newType = await detectPageType(page);
      if (newType === 'course') {
        log('[返回] ✅ 已回到课程列表');
        return true;
      }
    }

    // 最后手段：直接导航（这是唯一会用 goto 的地方）
    log('[返回] 后退失败，直接导航到课程页...');
    await page.goto(CONFIG.courseUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3);
    return true;
  } catch (e) {
    log(`[返回] 出错: ${e.message}`);
    return false;
  }
}

// ============ 主流程 ============
async function main() {
  log('');
  log('╔══════════════════════════════════════════╗');
  log('║   杭州人社学习平台 - 自动刷课 v3.6      ║');
  log('║   新增：已学课程去重，不再重复刷同一门课  ║');
  log('╚══════════════════════════════════════════╝');
  log('');

  // 设置日志文件
  logFile = path.join(process.env.HOME, 'auto-study-project', 'auto-study.log');
  log(`日志文件: ${logFile}`);

  // ============ 核心修改1：使用 storageState 持久化登录 ============
  // launchPersistentContext + channel:chrome 有兼容性问题，改用 storageState 保存/加载 Cookie
  const STATE_FILE = path.join(process.env.HOME, 'auto-study-project', 'auth-state.json');

  log('[启动] 启动浏览器...');
  log(`[启动] 登录状态文件: ${STATE_FILE}`);

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    channel: 'chrome',
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // 尝试加载已保存的登录状态
  let savedState = null;
  if (fs.existsSync(STATE_FILE)) {
    try {
      savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      log('[启动] ✅ 找到已保存的登录状态');
    } catch {
      log('[启动] ⚠️ 登录状态文件损坏，将重新登录');
    }
  }

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    storageState: savedState || undefined,
  });

  // 注册退出处理，确保登录状态被保存
  const saveStateAndExit = async (signal) => {
    log(`\n[退出] 收到 ${signal} 信号，保存登录状态...`);
    try {
      const state = await context.storageState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      log('[退出] ✅ 登录状态已保存');
    } catch (e) {
      log(`[退出] 保存状态失败: ${e.message}`);
    }
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', () => saveStateAndExit('SIGINT'));
  process.on('SIGTERM', () => saveStateAndExit('SIGTERM'));
  process.on('SIGHUP', () => saveStateAndExit('SIGHUP'));

  let page = await context.newPage();

  // 自动处理原生弹窗
  page.on('dialog', async d => {
    log(`[弹窗] ${d.type()}: ${d.message().substring(0, 80)}`);
    await d.accept();
  });

  // ============ 核心修改2：智能登录检测 ============
  log('[1/2] 打开学习平台...');
  await page.goto(CONFIG.courseUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(3);

  const loggedIn = await isLoggedIn(page);

  if (loggedIn) {
    log('[1/2] ✅ 已登录（使用保存的登录状态），跳过登录步骤');
    // 保存最新状态（Cookie 可能已刷新）
    try {
      const state = await context.storageState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {}
  } else {
    // 清除旧的状态文件（可能已过期）
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      log('[1/2] 旧登录状态已过期，已清除');
    }

    log('');
    log('┌────────────────────────────────────────────┐');
    log('│  👤 请在浏览器中登录你的账号               │');
    log('│  登录成功后回到终端按 回车键 继续          │');
    log('│                                            │');
    log('│  💡 登录一次即可，下次自动恢复登录状态     │');
    log('└────────────────────────────────────────────┘');
    log('');

    await new Promise(resolve => process.stdin.once('data', () => resolve()));

    // 登录成功后保存状态
    try {
      const state = await context.storageState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      log('[1/2] ✅ 登录状态已保存');
    } catch (e) {
      log(`[1/2] ⚠️ 保存登录状态失败: ${e.message}`);
    }
  }

  // ============ 核心修改3：智能主循环（处理新标签页） ============
  log('[2/2] 开始自动刷课！');
  log('');

  // 加载已学课程记录（去重）
  loadLearnedCourses();

  while (true) {
    let detailPage = null;
    let mainListPage = page; // 课程列表页引用

    try {
      log('────────────── 开始选新课 ──────────────');

      // 只在需要时导航到课程页面
      const pageType = await detectPageType(page);
      if (pageType !== 'course') {
        await navigateTo(page, CONFIG.courseUrl);
      }

      // 选择"一般公需"分类
      await selectCourseCategory(page);
      await sleep(1);

      // 点击查询
      await searchCourses(page);
      await sleep(2);

      // 选择最合适的课程（可能在新标签页打开）
      const result = await pickBestCourse(page, context);
      if (!result) {
        log('[❌] 没有可选课程了，可能已全部完成！');
        break;
      }

      // 获取详情页（可能是新标签页）
      detailPage = result.detailPage || result.page || page;
      mainListPage = result.mainPage || null;

      log(`[主流程] 详情页URL: ${detailPage.url()}`);

      // 在详情页点击"立即学习"（也可能打开新标签页）
      const started = await clickStartLearning(detailPage, context);
      if (!started) {
        log('[❌] 无法开始学习，换下一课...');
        // 关闭详情页标签
        if (detailPage !== page && !detailPage.isClosed()) {
          await detailPage.close().catch(() => {});
        }
        // 确保回到课程列表
        const curType = await detectPageType(page);
        if (curType !== 'course') {
          await navigateTo(page, CONFIG.courseUrl);
        }
        continue;
      }

      // 检查"立即学习"是否打开了新标签页（视频页）
      let videoPage = detailPage;
      // 查找最新的视频页面标签
      const allPages = context.pages();
      for (const p of allPages) {
        if (!p.isClosed() && p.url().includes('/class')) {
          videoPage = p;
          log(`[主流程] 视频在新标签页: ${p.url()}`);
          break;
        }
      }

      // 观看视频
      const finished = await watchCurrentVideo(videoPage);
      if (!finished) {
        log('[⚠️] 视频观看异常，换下一课...');
      }

      // 清理：关闭视频页和详情页标签，回到课程列表
      if (videoPage !== page && !videoPage.isClosed()) {
        await videoPage.close().catch(() => {});
      }
      if (detailPage !== page && detailPage !== videoPage && !detailPage.isClosed()) {
        await detailPage.close().catch(() => {});
      }
      // 关闭其他多余的标签页
      for (const p of context.pages()) {
        if (p !== page && !p.isClosed()) {
          await p.close().catch(() => {});
        }
      }

      // 确保主页面在课程列表
      const curType = await detectPageType(page);
      if (curType !== 'course') {
        await navigateTo(page, CONFIG.courseUrl);
      }
      await sleep(2);

    } catch (e) {
      log(`[❌] 主循环异常: ${e.message}`);
      // 清理所有多余标签页
      for (const p of context.pages()) {
        if (p !== page && !p.isClosed()) {
          await p.close().catch(() => {});
        }
      }
      await sleep(5);
      // 尝试恢复到课程列表
      try {
        await page.goto(CONFIG.courseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      } catch {}
    }
  }

  log('');
  log('========================================');
  log(`  🎉 自动学习结束！`);
  log(`  完成 ${completedCourses} 课，累计 ${totalStudyHours} 学时`);
  log('========================================');

  // 正常退出时也保存状态
  try {
    const state = await context.storageState();
    fs.writeFileSync(path.join(process.env.HOME, 'auto-study-project', 'auth-state.json'), JSON.stringify(state, null, 2));
  } catch {}
  await context.close();
  await browser.close();
}

main().catch(e => {
  console.error('脚本异常:', e.message);
  process.exit(1);
});
