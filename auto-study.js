/**
 * 杭州人社学习平台 - 自动刷课脚本 v3.7
 *
 * v3.7（双阶段版）
 * 功能：
 *   1. 先学习“一般公需”至 25 学时
 *   2. 自动切换至“专业科目”学习至 65 学时
 *   3. 总学时 90，满足年度要求
 *
 * 其他特性：
 *   - 登录持久化
 *   - 去重（不重复刷已学课程）
 *   - 自动翻页
 *   - 多重播放策略
 *   - 防挂机
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
const os = require('os');

// ============ 配置 ============
const HOME = os.homedir();
const PROJECT_DIR = path.join(HOME, 'auto-study-project');

if (!fs.existsSync(PROJECT_DIR)) {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
}

const CONFIG = {
  baseUrl: 'https://learning.hzrs.hangzhou.gov.cn',
  courseUrl: 'https://learning.hzrs.hangzhou.gov.cn/#/Course',
  activityInterval: 30,
  checkInterval: 6,
  videoStuckTimeout: 300,
  headless: false,

  // ★ 阶段目标学时
  maxGeneralHours: 25,      // 一般公需目标
  maxProfessionalHours: 65, // 专业科目目标

  // 关键词（用于相关性选课）
  preferKeywords: [
    '智慧交通', '施工', '交通', '工程', 'BIM', '信息化', '数字化', '人工智能', 'AI',
    '大数据', '云计算',  '智能', '算法',
    '机器学习', '深度学习',
  ],
  generalKeywords: [
    '国家','中国', '法律', '法规', '标准',
    '管理', '项目管理', '经济',
  ],
  learnedCoursesFile: path.join(PROJECT_DIR, 'learned-courses.json'),
};

// ============ 全局状态 ============
let videoStuckCounter = 0;
let lastProgress = -1;
let completedCourses = 0;
let totalStudyHours = 0;

// ★ 分阶段学时统计
let generalHours = 0;
let professionalHours = 0;

let learnedCourseNames = new Set();
let learnedCourses = [];
let currentCourseName = '';
let logFile = null;

// ★ 当前学习阶段: 'general' 或 'professional'
let currentStage = 'general';

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

// ============ 去重管理 ============
function loadLearnedCourses() {
  const filePath = CONFIG.learnedCoursesFile;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

// ============ 弹窗处理 ============
async function handlePopups(page) {
  try {
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

    const popupSelectors = [
      '.el-message-box__btns .el-button--primary',
      '.el-message-box__btns button:first-child',
      '.el-dialog__footer .el-button--primary',
      'button:has-text("确认")',
      'button:has-text("确定")',
      'button:has-text("继续")',
      'button:has-text("继续学习")',
      'button:has-text("我知道了")',
      'a:has-text("确认")',
      'a:has-text("确定")',
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

// ============ 模拟活跃 ============
async function simulateActivity(page) {
  try {
    const x = 300 + Math.random() * 600;
    const y = 200 + Math.random() * 400;
    await page.mouse.move(x, y);
    if (Math.random() > 0.7) {
      await page.mouse.wheel(0, Math.random() > 0.5 ? 100 : -100);
    }
  } catch {}
}

// ============ 视频操作 ============
async function getVideoInfo(page) {
  return page.evaluate(() => {
    const videos = document.querySelectorAll('video');
    if (videos.length === 0) return null;
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

  try {
    const played = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return 'no-video';
      if (!v.paused) return 'already-playing';
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

  const playBtnSelectors = [
    '.prism-big-play-btn', '.prism-play-btn',
    '.vjs-big-play-button', '.vjs-play-control.vjs-paused',
    '.xgplayer-start', '.xgplayer-play-btn',
    '.ckplayer-play',
    'button[aria-label="Play"]', 'button[aria-label="播放"]',
    '[class*="play-btn"]:not([class*="pause"])',
    '[class*="Play"]',
    '.video-wrapper', '.player-wrapper',
  ];

  for (const sel of playBtnSelectors) {
    try {
      const btn = await page.$(sel);
      if (btn && await btn.isVisible()) {
        await btn.click();
        log(`[播放] 点击播放按钮: ${sel}`);
        await sleep(2);
        const info = await getVideoInfo(page);
        if (info && !info.paused) {
          log('[播放] ✅ 视频已开始播放');
          return true;
        }
      }
    } catch {}
  }

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

// ============ 页面类型检测 ============
async function detectPageType(page) {
  const url = page.url();
  if (url.includes('/#/class')) return 'video';
  if (url.includes('/#/CourseDetail')) return 'detail';
  if (url.includes('/#/Course')) return 'course';
  if (url.includes('learning.hzrs.hangzhou.gov.cn')) return 'site';
  return 'unknown';
}

async function isLoggedIn(page) {
  try {
    const result = await page.evaluate(() => {
      const indicators = [
        '.user-info', '.user-name', '.avatar', '[class*="user"]',
        'a:has-text("退出")', 'button:has-text("退出")',
        '[class*="logout"]', '[class*="sign-out"]',
        '.header-right', '.nav-user',
      ];
      for (const sel of indicators) {
        const el = document.querySelector(sel);
        if (el && el.offsetWidth > 0) return true;
      }
      const courseEl = document.querySelector('.course-card, [class*="course"], .el-table');
      if (courseEl) return true;
      return false;
    });
    return result;
  } catch {
    return false;
  }
}

async function navigateTo(page, targetUrl) {
  const currentUrl = page.url();
  if (currentUrl.includes(new URL(targetUrl).hash)) {
    log('[导航] 已在目标页面，无需跳转');
    return;
  }
  if (currentUrl.includes('learning.hzrs.hangzhou.gov.cn')) {
    log('[导航] SPA内导航...');
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2);
    return;
  }
  log('[导航] 打开页面...');
  await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(3);
}

// ============ 选课分类（支持动态切换） ============
async function selectCourseCategory(page, categoryName = '一般公需') {
  log(`[选课] 选择分类: ${categoryName} ...`);
  try {
    const pageType = await detectPageType(page);
    if (pageType !== 'course') {
      await navigateTo(page, CONFIG.courseUrl);
    }

    // 先打开下拉框
    const selectOpened = await page.evaluate(() => {
      const selects = document.querySelectorAll('.el-select');
      for (let i = 0; i < selects.length; i++) {
        const input = selects[i].querySelector('.el-input__inner, input');
        if (input) {
          const placeholder = input.getAttribute('placeholder') || '';
          if (i === 0 || placeholder.includes('类别') || placeholder.includes('课程')) {
            input.click();
            return { index: i, placeholder, value: input.value };
          }
        }
      }
      return null;
    });

    if (!selectOpened) {
      log('[选课] 无法打开分类下拉框，尝试备用方法...');
      // 备用：点击第一个 el-select
      const firstSelect = await page.$('.el-select');
      if (firstSelect) {
        await firstSelect.click();
        await sleep(1);
      } else {
        log('[选课] ⚠️ 未找到分类下拉框');
        return false;
      }
    }

    await sleep(1);

    // 选择指定分类
    const optionClicked = await page.evaluate((target) => {
      const items = document.querySelectorAll('.el-select-dropdown__item');
      for (const item of items) {
        const text = item.textContent.trim();
        if (text.includes(target)) {
          item.click();
          return text;
        }
      }
      return null;
    }, categoryName);

    if (optionClicked) {
      log(`[选课✅] 选中: ${optionClicked}`);
      await sleep(1);
      return true;
    } else {
      log(`[选课] 未找到分类: ${categoryName}，列出所有选项...`);
      const options = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('.el-select-dropdown__item'))
          .map(el => el.textContent.trim());
      });
      log(`[选课] 可选项: ${options.join(' | ')}`);
      return false;
    }
  } catch (e) {
    log(`[选课] 出错: ${e.message}`);
    return false;
  }
}

async function searchCourses(page) {
  log('[搜索] 点击查询...');
  try {
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
    await page.keyboard.press('Enter');
    log('[搜索] 按回车查询');
    await sleep(3);
    return true;
  } catch (e) {
    log(`[搜索] 出错: ${e.message}`);
    return false;
  }
}

// ======================================================================
// ★ pickBestCourse - 按相关性选择（支持当前分类）
// ======================================================================
async function pickBestCourse(page, context) {
  log('[选课] 从课程列表中选择最合适的课程...');

  try {
    const courses = await page.evaluate(() => {
      const items = [];

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

      if (cards.length === 0) {
        const allDivs = document.querySelectorAll('div, section, article, li, a, span');
        const courseElements = new Set();
        for (const el of allDivs) {
          const text = el.textContent || '';
          if (text.includes('讲师') && text.includes('学时')) {
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

      if (cards.length === 0) {
        const allDivs = document.querySelectorAll('div, section, article, li');
        const courseElements = new Set();
        for (const el of allDivs) {
          const text = el.textContent || '';
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
        let name = '';
        const titleSpan = card.querySelector('.Line span');
        if (titleSpan) {
          name = titleSpan.textContent.trim();
        } else {
          const titleEl = card.querySelector('h3, h4, .title, .course-title, .name');
          if (titleEl) name = titleEl.textContent.trim();
        }
        if (!name) {
          const fullText = card.textContent || '';
          const match = fullText.match(/\]([^\n讲师]+)/);
          name = match ? match[1].trim() : fullText.substring(0, 80).replace(/\n/g, ' ').trim();
        }

        const text = card.textContent || '';
        const extra = card.querySelector('.tag, .label, .type')?.textContent || '';
        const fullScoreText = name + ' ' + text + ' ' + extra;

        const link = card.querySelector('a[href]');
        const href = link ? link.getAttribute('href') : null;
        const onclick = card.getAttribute('onclick') || '';
        const cursor = window.getComputedStyle(card).cursor;

        items.push({
          index,
          name,
          text: text.substring(0, 500),
          fullScoreText,
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

      items.sort((a, b) => a.rect.top - b.rect.top);
      items.forEach((item, i) => item.index = i);
      return items;
    });

    if (courses.length === 0) {
      log('[选课] ⚠️ 未找到课程元素');
      return null;
    }

    log(`[选课] 找到 ${courses.length} 个课程`);

    const scored = courses.map(c => {
      let score = getRelevanceScore(c.fullScoreText);
      if (c.name) {
        score += getRelevanceScore(c.name) * 2;
      }
      return { ...c, score };
    });

    scored.sort((a, b) => b.score - a.score);

    log('[选课] 候选课程（按分数排序）：');
    for (let i = 0; i < Math.min(scored.length, 15); i++) {
      const s = scored[i];
      const nameDisplay = s.name || s.text.substring(0, 40).replace(/\n/g, ' ');
      const isLearned = learnedCourseNames.has(s.name);
      log(`  [#${i}] 分数:${s.score} | ${isLearned ? '✅已学' : '⬜未学'} | ${nameDisplay}`);
    }

    const available = scored.filter(c => {
      if (c.name && learnedCourseNames.has(c.name)) return false;
      const fallbackName = c.text.substring(0, 60).replace(/\n/g, ' ');
      if (!c.name && learnedCourseNames.has(fallbackName)) return false;
      return true;
    });

    if (available.length === 0) {
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

    const maxScore = available[0].score;
    if (maxScore === 0) {
      log('[选课] 当前页所有未学课程相关性为0，尝试翻页寻找更高相关性...');
      const nextBtn = await page.$('button:has-text("下一页"), .el-pagination .btn-next, .btn-next');
      if (nextBtn) {
        await nextBtn.click();
        await sleep(3);
        return pickBestCourse(page, context);
      } else {
        log('[选课] 没有下一页，只能选择当前页的第一个（分数为0）');
        const chosen = available[0];
        currentCourseName = chosen.name || chosen.text.substring(0, 60).replace(/\n/g, ' ');
        log(`[选课✅] 选中: ${currentCourseName} (相关性:${chosen.score})`);
        const result = await clickCourseElement(page, context, chosen);
        if (result && result.page) {
          page = result.page;
          const pageType = await detectPageType(page);
          log(`[选课✅] 已到达${pageType === 'detail' ? '详情' : pageType === 'video' ? '视频' : '其他'}页`);
          return { course: chosen, detailPage: page, mainPage: result.mainPage };
        } else {
          for (let i = 1; i < available.length; i++) {
            const candidate = available[i];
            currentCourseName = candidate.name || candidate.text.substring(0, 60).replace(/\n/g, ' ');
            log(`[选课] 尝试候选 #${i}: ${currentCourseName} (分数:${candidate.score})`);
            const res = await clickCourseElement(page, context, candidate);
            if (res && res.page) {
              page = res.page;
              const pageType = await detectPageType(page);
              log(`[选课✅] 已到达${pageType === 'detail' ? '详情' : pageType === 'video' ? '视频' : '其他'}页`);
              return { course: candidate, detailPage: page, mainPage: res.mainPage };
            }
          }
          log('[选课] 所有候选点击均失败');
          return null;
        }
      }
    }

    for (let i = 0; i < available.length; i++) {
      const candidate = available[i];
      if (candidate.score === 0 && i > 0) {
        log('[选课] 所有正分课程尝试失败，放弃');
        break;
      }
      currentCourseName = candidate.name || candidate.text.substring(0, 60).replace(/\n/g, ' ');
      log(`[选课] 尝试候选 #${i}: ${currentCourseName} (分数:${candidate.score})`);
      const result = await clickCourseElement(page, context, candidate);
      if (result && result.page) {
        page = result.page;
        const pageType = await detectPageType(page);
        log(`[选课✅] 已到达${pageType === 'detail' ? '详情' : pageType === 'video' ? '视频' : '其他'}页`);
        return { course: candidate, detailPage: page, mainPage: result.mainPage };
      }
      log(`[选课] 候选 #${i} 点击失败，尝试下一个...`);
    }

    log('[选课] 当前页正分课程均点击失败，尝试翻页...');
    const nextBtn = await page.$('button:has-text("下一页"), .el-pagination .btn-next, .btn-next');
    if (nextBtn) {
      await nextBtn.click();
      await sleep(3);
      return pickBestCourse(page, context);
    }

    log('[选课] 没有更多课程可尝试');
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

  const clickStrategies = [
    {
      name: 'Playwright原生点击itemBox',
      fn: async () => {
        const itemBoxes = await page.$$('.itemBox');
        log(`[选课] 找到 ${itemBoxes.length} 个 .itemBox`);
        for (let i = 0; i < itemBoxes.length; i++) {
          const boxText = await itemBoxes[i].textContent().catch(() => '');
          if (boxText.includes(courseName)) {
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
            const innerDivs = await itemBoxes[i].$$('div');
            if (innerDivs.length > 0) {
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

  for (const strategy of clickStrategies) {
    try {
      log(`[选课] 尝试策略: ${strategy.name}`);
      const clicked = await strategy.fn();
      if (!clicked) {
        log(`[选课] 策略未找到目标元素`);
        continue;
      }

      log('[选课] 点击完成，等待5秒检查结果...');
      await sleep(5);

      const pageType = await detectPageType(page);
      if (pageType === 'detail' || pageType === 'video') {
        log(`[选课✅] 当前页已导航到${pageType}页: ${page.url()}`);
        return { page, mainPage: null };
      }

      const allPagesNow = context.pages();
      for (const p of allPagesNow) {
        if (p.isClosed()) continue;
        if (pagesBefore.has(p.url())) continue;
        const pUrl = p.url();
        if (pUrl.includes('learning.hzrs.hangzhou.gov.cn')) {
          log(`[选课✅] 新标签页已打开: ${pUrl}`);
          await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          return { page: p, mainPage: page };
        }
      }

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

  log('[选课] 所有点击策略均未跳转，尝试从Vue数据提取courseid...');
  try {
    const courseInfo = await page.evaluate((searchName) => {
      const boxes = document.querySelectorAll('.itemBox');
      for (const box of boxes) {
        if (!box.textContent.includes(searchName)) continue;
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

// ============ 点击"立即学习" ============
async function clickStartLearning(page, context) {
  log('[详情] 在课程详情页点击"立即学习"...');
  try {
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

    log('[详情] 等待详情页加载...');
    await sleep(3);

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
              await sleep(5);

              const afterType = await detectPageType(page);
              if (afterType === 'video') {
                log('[详情✅] 已跳转到视频页面');
                return true;
              }

              const allPagesNow = context.pages();
              for (const p of allPagesNow) {
                if (p.isClosed() || p === page) continue;
                const pUrl = p.url();
                if (!pagesBefore.has(pUrl) && pUrl.includes('learning.hzrs.hangzhou.gov.cn')) {
                  log(`[详情✅] 视频在新标签页打开: ${pUrl}`);
                  await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
                  return true;
                }
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

// ============ 观看单个课程（支持阶段学时累计） ============
async function watchCurrentVideo(page) {
  log(`[观看] 开始观看: ${currentCourseName}`);
  await sleep(5);

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

  const activityTimer = setInterval(() => simulateActivity(page), CONFIG.activityInterval * 1000);
  let consecutiveNoVideo = 0;
  let statusLogCounter = 0;

  try {
    while (true) {
      await handlePopups(page);
      const info = await getVideoInfo(page);

      if (info) {
        consecutiveNoVideo = 0;
        const pct = info.duration > 0 ? ((info.currentTime / info.duration) * 100).toFixed(1) : 0;
        const status = info.ended ? '✅结束' : (info.paused ? '⏸暂停' : '▶播放');
        statusLogCounter++;
        if (statusLogCounter % 5 === 0 || info.ended || info.paused) {
          log(`[视频] ${fmt(info.currentTime)}/${fmt(info.duration)} | ${pct}% | ${status} | 已完成${completedCourses}课`);
        }

        if (info.paused && !info.ended) {
          log('[视频] 检测到暂停，重新播放...');
          await tryPlayVideo(page);
          await sleep(2);
        }

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

        if (info.ended || (info.duration > 0 && info.currentTime >= info.duration - 2)) {
          completedCourses++;
          // ★ 从课程名提取学时
          const hoursMatch = currentCourseName.match(/学时[：:](\d+\.?\d*)/);
          const hours = hoursMatch ? parseFloat(hoursMatch[1]) : 1;
          totalStudyHours += hours;

          // ★ 根据当前阶段累加学时
          if (currentStage === 'general') {
            generalHours += hours;
          } else if (currentStage === 'professional') {
            professionalHours += hours;
          }

          saveLearnedCourse(currentCourseName);

          log('');
          log('  ══════════════════════════════════════');
          log(`  ✅ 第${completedCourses}课完成！+${hours}学时 | 累计: ${totalStudyHours}学时`);
          log(`     📊 一般公需: ${generalHours} / ${CONFIG.maxGeneralHours}  专业科目: ${professionalHours} / ${CONFIG.maxProfessionalHours}`);
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
    await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await sleep(2);
    const pageType = await detectPageType(page);
    if (pageType === 'course') {
      log('[返回] ✅ 已回到课程列表');
      return true;
    }
    if (pageType === 'detail') {
      await page.goBack({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await sleep(2);
      const newType = await detectPageType(page);
      if (newType === 'course') {
        log('[返回] ✅ 已回到课程列表');
        return true;
      }
    }
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
  log('║   杭州人社学习平台 - 双阶段自动刷课      ║');
  log('║   一般公需 25h → 专业科目 65h           ║');
  log('╚══════════════════════════════════════════╝');
  log('');

  logFile = path.join(PROJECT_DIR, 'auto-study.log');
  log(`日志文件: ${logFile}`);

  const STATE_FILE = path.join(PROJECT_DIR, 'auth-state.json');
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

  page.on('dialog', async d => {
    log(`[弹窗] ${d.type()}: ${d.message().substring(0, 80)}`);
    await d.accept();
  });

  log('[1/2] 打开学习平台...');
  await page.goto(CONFIG.courseUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await sleep(3);

  const loggedIn = await isLoggedIn(page);

  if (loggedIn) {
    log('[1/2] ✅ 已登录（使用保存的登录状态），跳过登录步骤');
    try {
      const state = await context.storageState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch {}
  } else {
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
    try {
      const state = await context.storageState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      log('[1/2] ✅ 登录状态已保存');
    } catch (e) {
      log(`[1/2] ⚠️ 保存登录状态失败: ${e.message}`);
    }
  }

  log('[2/2] 开始自动刷课！');
  log('');
  loadLearnedCourses();

  // ★ 设置初始阶段
  currentStage = 'general';
  let targetCategory = '一般公需';

  while (true) {
    let detailPage = null;
    let mainListPage = page;

    try {
      // ★ 阶段切换检测
      if (currentStage === 'general' && generalHours >= CONFIG.maxGeneralHours) {
        log(`🎯 一般公需已学 ${generalHours} 学时，达到目标 ${CONFIG.maxGeneralHours}，切换至专业科目！`);
        currentStage = 'professional';
        targetCategory = '专业科目';
        // 刷新课程列表以应用新分类
        await navigateTo(page, CONFIG.courseUrl);
        await sleep(2);
      }

      // ★ 检查是否已完成专业目标
      if (currentStage === 'professional' && professionalHours >= CONFIG.maxProfessionalHours) {
        log(`🎉 专业科目已学 ${professionalHours} 学时，达到目标 ${CONFIG.maxProfessionalHours}，全部完成！`);
        break;
      }

      log(`────────────── 当前阶段: ${currentStage === 'general' ? '一般公需' : '专业科目'} (${currentStage === 'general' ? generalHours : professionalHours}/${currentStage === 'general' ? CONFIG.maxGeneralHours : CONFIG.maxProfessionalHours}) ──────────────`);

      const pageType = await detectPageType(page);
      if (pageType !== 'course') {
        await navigateTo(page, CONFIG.courseUrl);
      }

      // ★ 选择对应分类
      await selectCourseCategory(page, targetCategory);
      await sleep(1);
      await searchCourses(page);
      await sleep(2);

      const result = await pickBestCourse(page, context);
      if (!result) {
        log('[❌] 当前分类没有可选课程，可能已全部完成或需手动处理');
        // 如果一般公需已满但专业科目还有课，这里会提示，我们尝试翻页或切换分类
        // 但 pickBestCourse 内部会翻页，若实在无课则退出
        // 如果无课且阶段未完成，或许需要跳转到其他页面，这里简单退出循环
        break;
      }

      detailPage = result.detailPage || result.page || page;
      mainListPage = result.mainPage || null;
      log(`[主流程] 详情页URL: ${detailPage.url()}`);

      const started = await clickStartLearning(detailPage, context);
      if (!started) {
        log('[❌] 无法开始学习，换下一课...');
        if (detailPage !== page && !detailPage.isClosed()) {
          await detailPage.close().catch(() => {});
        }
        const curType = await detectPageType(page);
        if (curType !== 'course') {
          await navigateTo(page, CONFIG.courseUrl);
        }
        continue;
      }

      let videoPage = detailPage;
      const allPages = context.pages();
      for (const p of allPages) {
        if (!p.isClosed() && p.url().includes('/class')) {
          videoPage = p;
          log(`[主流程] 视频在新标签页: ${p.url()}`);
          break;
        }
      }

      const finished = await watchCurrentVideo(videoPage);
      if (!finished) {
        log('[⚠️] 视频观看异常，换下一课...');
      }

      if (videoPage !== page && !videoPage.isClosed()) {
        await videoPage.close().catch(() => {});
      }
      if (detailPage !== page && detailPage !== videoPage && !detailPage.isClosed()) {
        await detailPage.close().catch(() => {});
      }
      for (const p of context.pages()) {
        if (p !== page && !p.isClosed()) {
          await p.close().catch(() => {});
        }
      }

      const curType = await detectPageType(page);
      if (curType !== 'course') {
        await navigateTo(page, CONFIG.courseUrl);
      }
      await sleep(2);

    } catch (e) {
      log(`[❌] 主循环异常: ${e.message}`);
      for (const p of context.pages()) {
        if (p !== page && !p.isClosed()) {
          await p.close().catch(() => {});
        }
      }
      await sleep(5);
      try {
        await page.goto(CONFIG.courseUrl, { waitUntil: 'networkidle', timeout: 30000 });
      } catch {}
    }
  }

  log('');
  log('========================================');
  log(`  🎉 全部学习目标已完成！`);
  log(`  一般公需: ${generalHours} 学时 (目标 ${CONFIG.maxGeneralHours})`);
  log(`  专业科目: ${professionalHours} 学时 (目标 ${CONFIG.maxProfessionalHours})`);
  log(`  总学时: ${totalStudyHours} 学时`);
  log('========================================');

  try {
    const state = await context.storageState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
  await context.close();
  await browser.close();
}

main().catch(e => {
  console.error('脚本异常:', e.message);
  process.exit(1);
});
