const fs = require("fs");
const path = require("path");

const root = __dirname;
const miniprogramRoot = path.join(root, "miniprogram");
const cloudfunctionsRoot = path.join(root, "cloudfunctions");
const servicesRoot = path.join(root, "services");
const errors = [];

function walk(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") {
      return [];
    }

    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function relative(filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function checkJavaScript(filePath) {
  const source = fs.readFileSync(filePath, "utf8");

  try {
    new Function(source);
  } catch (error) {
    errors.push(`${relative(filePath)}: JavaScript 语法错误：${error.message}`);
  }
}

function checkJson(filePath) {
  const source = fs.readFileSync(filePath, "utf8");

  try {
    JSON.parse(source);
  } catch (error) {
    errors.push(`${relative(filePath)}: JSON 无效：${error.message}`);
  }
}

function collectRegisteredPages(appConfig) {
  const mainPages = Array.isArray(appConfig.pages) ? appConfig.pages : [];
  const subpackagePages = (
    Array.isArray(appConfig.subPackages) ? appConfig.subPackages : []
  ).flatMap((subpackage) => {
    const subpackageRoot = String(subpackage.root || "").replace(/\/$/, "");
    const pages = Array.isArray(subpackage.pages) ? subpackage.pages : [];

    return pages.map((pagePath) => `${subpackageRoot}/${pagePath}`);
  });

  return mainPages.concat(subpackagePages);
}

function checkRegisteredPages() {
  const appConfig = JSON.parse(
    fs.readFileSync(path.join(miniprogramRoot, "app.json"), "utf8")
  );
  const requiredExtensions = [".js", ".json", ".wxml", ".wxss"];
  const registeredPages = new Set();

  collectRegisteredPages(appConfig).forEach((pagePath) => {
    if (registeredPages.has(pagePath)) {
      errors.push(`app.json 重复注册页面：${pagePath}`);
    }

    registeredPages.add(pagePath);

    requiredExtensions.forEach((extension) => {
      const filePath = path.join(miniprogramRoot, `${pagePath}${extension}`);

      if (!fs.existsSync(filePath)) {
        errors.push(`app.json 页面缺少文件：${relative(filePath)}`);
      }
    });
  });

  return appConfig;
}

function checkPageGraph(appConfig, sourceFiles) {
  const registeredPages = new Set(collectRegisteredPages(appConfig));
  const routePattern = /\/pages\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g;

  (appConfig.tabBar && Array.isArray(appConfig.tabBar.list)
    ? appConfig.tabBar.list
    : []
  ).forEach((item) => {
    if (!registeredPages.has(item.pagePath)) {
      errors.push(`tabBar 指向未注册页面：${item.pagePath}`);
    }
  });

  sourceFiles.forEach((filePath) => {
    if (!/\.(?:js|json|wxml)$/.test(filePath)) {
      return;
    }

    const source = fs.readFileSync(filePath, "utf8");
    const routes = source.match(routePattern) || [];

    routes.forEach((route) => {
      const pagePath = route.replace(/^\//, "");

      if (!registeredPages.has(pagePath)) {
        errors.push(`${relative(filePath)}: 跳转目标未在 app.json 注册：${route}`);
      }
    });
  });

  const pagesRoot = path.join(miniprogramRoot, "pages");

  fs.readdirSync(pagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .forEach((entry) => {
      const pagePath = `pages/${entry.name}/${entry.name}`;
      const wxmlPath = path.join(pagesRoot, entry.name, `${entry.name}.wxml`);

      if (fs.existsSync(wxmlPath) && !registeredPages.has(pagePath)) {
        errors.push(`存在未注册页面目录：${pagePath}`);
      }
    });
}

function checkWxmlHandlers(wxmlFiles) {
  const handlerPattern = /(?:bind|catch)[\w-]*\s*=\s*["']([A-Za-z_$][\w$]*)["']/g;

  wxmlFiles.forEach((wxmlPath) => {
    const jsPath = wxmlPath.replace(/\.wxml$/, ".js");

    if (!fs.existsSync(jsPath)) {
      return;
    }

    const wxml = fs.readFileSync(wxmlPath, "utf8");
    const javascript = fs.readFileSync(jsPath, "utf8");
    const handlers = new Set();
    let match = handlerPattern.exec(wxml);

    while (match) {
      handlers.add(match[1]);
      match = handlerPattern.exec(wxml);
    }

    handlers.forEach((handler) => {
      const methodPattern = new RegExp(`\\b${handler}\\s*\\(`);

      if (!methodPattern.test(javascript)) {
        errors.push(
          `${relative(wxmlPath)}: 事件处理函数 ${handler} 未在对应 JS 中找到`
        );
      }
    });
  });
}

function checkWxmlAttributes(wxmlFiles) {
  const attributePattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  const openingTagPattern = /<\s*[A-Za-z][\w-]*\b([^>]*)>/g;

  wxmlFiles.forEach((wxmlPath) => {
    const source = fs.readFileSync(wxmlPath, "utf8");
    let match = attributePattern.exec(source);

    while (match) {
      if (/\r?\n/.test(match[3])) {
        errors.push(
          `${relative(wxmlPath)}: 属性 ${match[1]} 的引号内容不能跨行`
        );
      }

      match = attributePattern.exec(source);
    }

    let tagMatch = openingTagPattern.exec(source);
    while (tagMatch) {
      const attributes = tagMatch[1];
      if (/\bwx:else\b/.test(attributes) && /\bwx:for\s*=/.test(attributes)) {
        errors.push(
          `${relative(wxmlPath)}: wx:else 与 wx:for 不能放在同一节点，请用 wx:else 的 block 包裹循环`
        );
      }
      tagMatch = openingTagPattern.exec(source);
    }
  });
}

function checkWxmlStructure(wxmlFiles) {
  const tagPattern = /<\s*(\/)?\s*([A-Za-z][\w-]*)([^>]*)>/g;

  wxmlFiles.forEach((wxmlPath) => {
    const source = fs
      .readFileSync(wxmlPath, "utf8")
      .replace(/<!--[\s\S]*?-->/g, "");
    const stack = [];
    let match = tagPattern.exec(source);

    while (match) {
      const closing = Boolean(match[1]);
      const tagName = match[2];
      const selfClosing = /\/\s*$/.test(match[3]);

      if (closing) {
        const expected = stack.pop();

        if (expected !== tagName) {
          errors.push(
            `${relative(wxmlPath)}: WXML 标签闭合错误，期望 </${
              expected || "无"
            }>，实际 </${tagName}>`
          );
          return;
        }
      } else if (!selfClosing) {
        stack.push(tagName);
      }

      match = tagPattern.exec(source);
    }

    if (stack.length > 0) {
      errors.push(
        `${relative(wxmlPath)}: WXML 标签未闭合：<${stack[stack.length - 1]}>`
      );
    }
  });
}

function checkWxssStructure(wxssFiles) {
  wxssFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    let braceDepth = 0;
    let commentOpen = false;
    let quote = "";

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      const nextCharacter = source[index + 1];

      if (commentOpen) {
        if (character === "*" && nextCharacter === "/") {
          commentOpen = false;
          index += 1;
        }
        continue;
      }

      if (quote) {
        if (character === "\\") {
          index += 1;
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }

      if (character === "/" && nextCharacter === "*") {
        commentOpen = true;
        index += 1;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === "{") {
        braceDepth += 1;
      } else if (character === "}") {
        braceDepth -= 1;

        if (braceDepth < 0) {
          errors.push(`${relative(filePath)}: WXSS 存在多余的右花括号`);
          return;
        }
      }
    }

    if (commentOpen) {
      errors.push(`${relative(filePath)}: WXSS 注释未闭合`);
    }

    if (quote) {
      errors.push(`${relative(filePath)}: WXSS 字符串未闭合`);
    }

    if (braceDepth > 0) {
      errors.push(`${relative(filePath)}: WXSS 存在未闭合的样式块`);
    }
  });
}

function checkStaticImages(sourceFiles) {
  const imagePattern = /["'](\/images\/[^"'{}]+)["']/g;
  const references = new Set();

  sourceFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    let match = imagePattern.exec(source);

    while (match) {
      references.add(match[1]);
      match = imagePattern.exec(source);
    }
  });

  references.forEach((reference) => {
    const filePath = path.join(miniprogramRoot, reference.replace(/^\//, ""));

    if (!fs.existsSync(filePath)) {
      errors.push(`静态图片不存在：${reference}`);
    }
  });

  return references.size;
}

function checkCloudFunctions() {
  const functionDirectories = fs
    .readdirSync(cloudfunctionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());

  functionDirectories.forEach((entry) => {
    ["index.js", "package.json", "config.json"].forEach((filename) => {
      const filePath = path.join(cloudfunctionsRoot, entry.name, filename);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        errors.push(`云函数文件缺失或为空：${relative(filePath)}`);
      }
    });
  });

  return {
    count: functionDirectories.length,
    names: new Set(functionDirectories.map((entry) => entry.name))
  };
}

function checkCloudFunctionCalls(javascriptFiles, cloudFunctionNames) {
  const callPattern = /callFunction\s*\(\s*\{\s*name\s*:\s*["']([\w-]+)["']/g;

  javascriptFiles.forEach((filePath) => {
    if (!filePath.startsWith(miniprogramRoot)) {
      return;
    }

    const source = fs.readFileSync(filePath, "utf8");
    let match = callPattern.exec(source);

    while (match) {
      if (!cloudFunctionNames.has(match[1])) {
        errors.push(
          `${relative(filePath)}: 调用了不存在的云函数：${match[1]}`
        );
      }

      match = callPattern.exec(source);
    }
  });
}

function checkRelativeRequires(javascriptFiles) {
  const requirePattern = /require\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;

  javascriptFiles.forEach((filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    let match = requirePattern.exec(source);

    while (match) {
      const target = path.resolve(path.dirname(filePath), match[1]);
      const candidates = [
        target,
        `${target}.js`,
        `${target}.json`,
        path.join(target, "index.js")
      ];

      if (!candidates.some((candidate) => fs.existsSync(candidate))) {
        errors.push(
          `${relative(filePath)}: require 目标不存在：${match[1]}`
        );
      }

      match = requirePattern.exec(source);
    }
  });
}

const sourceFiles = [
  ...walk(miniprogramRoot),
  ...walk(cloudfunctionsRoot),
  ...walk(servicesRoot)
];
const javascriptFiles = sourceFiles.filter((filePath) => filePath.endsWith(".js"));
const jsonFiles = [
  path.join(root, "package.json"),
  path.join(root, "project.config.json"),
  path.join(root, "project.private.config.json"),
  ...sourceFiles.filter((filePath) => filePath.endsWith(".json"))
];
const wxmlFiles = sourceFiles.filter((filePath) => filePath.endsWith(".wxml"));
const wxssFiles = sourceFiles.filter((filePath) => filePath.endsWith(".wxss"));

javascriptFiles.forEach(checkJavaScript);
jsonFiles.forEach(checkJson);
const appConfig = checkRegisteredPages();
checkPageGraph(appConfig, sourceFiles);
checkWxmlHandlers(wxmlFiles);
checkWxmlAttributes(wxmlFiles);
checkWxmlStructure(wxmlFiles);
checkWxssStructure(wxssFiles);
const imageCount = checkStaticImages(sourceFiles);
const cloudFunctions = checkCloudFunctions();
checkCloudFunctionCalls(javascriptFiles, cloudFunctions.names);
checkRelativeRequires(javascriptFiles);

if (errors.length > 0) {
  console.error("项目检查失败：");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(
    `项目检查通过：${javascriptFiles.length} 个 JS、${jsonFiles.length} 个 JSON、` +
      `${collectRegisteredPages(appConfig).length} 个页面、${cloudFunctions.count} 个云函数、` +
      `${imageCount} 个静态图片引用。`
  );
}
