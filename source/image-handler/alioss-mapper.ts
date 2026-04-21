// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ImageEdits, ImageHandlerError } from "./lib";
import { StatusCodes } from "./lib/enums";
import { QueryStringParameters } from "./lib/interfaces";

/**
 * 阿里云 OSS 图片处理参数映射器
 * 将阿里云 OSS 的 x-oss-process=image/resize,... 格式参数转换为 Sharp 编辑操作
 *
 * 支持的参数格式示例：
 *   image/resize,w_100,h_100,m_fill
 *   image/resize,p_50
 *   image/resize,l_200
 *   image/resize,m_pad,w_100,h_100,color_FF0000
 */

// 阿里云缩放模式到 Sharp fit 类型的映射
const ALI_MODE_TO_SHARP_FIT: Record<string, string> = {
  lfit: "inside", // 等比缩放至指定宽高区域内最大图形
  mfit: "outside", // 等比缩放至覆盖指定宽高区域
  fill: "cover", // 等比缩放至覆盖指定宽高区域并居中裁剪
  pad: "contain", // 等比缩放至指定宽高内最大图形并填充颜色
  fixed: "fill", // 固定宽高，强制缩放
};

export class AliOssMapper {
  /**
   * 判断 x-oss-process 参数是否包含阿里云 OSS 图片处理指令
   */
  public static isAliOssRequest(queryStringParameters: QueryStringParameters | undefined): boolean {
    if (!queryStringParameters) return false;
    const process = queryStringParameters["x-oss-process"];
    return typeof process === "string" && process.startsWith("image/");
  }

  /**
   * 从 x-oss-process 参数中提取图片 resize 编辑操作
   * @param processValue x-oss-process 参数值，如 "image/resize,w_100,h_100,m_fill"
   * @returns Sharp 兼容的 ImageEdits 对象
   */
  public mapProcessToEdits(processValue: string): ImageEdits {
    try {
      const edits: ImageEdits = {};

      // 按 "/" 分割多个操作，如 "image/resize,w_100/format,webp"
      const operations = processValue.split("/").slice(1); // 去掉开头的 "image"

      for (const operation of operations) {
        const parts = operation.split(",");
        const operationName = parts[0];

        if (operationName === "resize") {
          this.parseResize(parts.slice(1), edits);
        } else if (operationName === "quality") {
          this.parseQuality(parts.slice(1), edits);
        }
        // 未来可扩展其他操作：format, watermark 等
      }

      this.applyDefaults(edits);
      return edits;
    } catch (error) {
      console.error("阿里云 OSS 参数解析失败:", error);
      throw new ImageHandlerError(
        StatusCodes.BAD_REQUEST,
        "AliOssParsingError",
        "The x-oss-process parameter could not be parsed. Please check the syntax."
      );
    }
  }

  /**
   * 模拟阿里云 OSS 请求应用默认优化：
   * - JPEG 默认 quality 95（如果用户未显式指定 quality）
   * - 有 resize 操作时自动加轻微锐化
   */
  private applyDefaults(edits: ImageEdits): void {
    // 如果用户没有显式设置 quality，默认 JPEG quality 95
    if (!edits.jpeg) {
      edits.jpeg = { quality: 95 };
    }

    // 有 resize 操作时自动加锐化
    if (edits.resize && !edits.sharpen) {
      edits.sharpen = true;
    }
  }

  /**
   * 解析 resize 操作的参数
   * @param params 参数数组，如 ["w_100", "h_100", "m_fill"]
   * @param edits 编辑操作对象
   */
  private parseResize(params: string[], edits: ImageEdits): void {
    const resizeOptions: Record<string, unknown> = {};
    let mode = "lfit"; // 默认模式
    let hasPercentage = false;
    let percentage = 100;
    let longEdge: number | undefined;
    let shortEdge: number | undefined;
    let padColor: string | undefined;
    let limitEnabled = true; // 默认不允许放大

    for (const param of params) {
      const underscoreIndex = param.indexOf("_");
      if (underscoreIndex === -1) continue;

      const key = param.substring(0, underscoreIndex);
      const value = param.substring(underscoreIndex + 1);

      switch (key) {
        case "w":
          resizeOptions.width = this.clampInt(parseInt(value, 10), 1, 16384);
          break;
        case "h":
          resizeOptions.height = this.clampInt(parseInt(value, 10), 1, 16384);
          break;
        case "m":
          mode = value;
          break;
        case "p":
          hasPercentage = true;
          percentage = this.clampInt(parseInt(value, 10), 1, 1000);
          break;
        case "l":
          longEdge = this.clampInt(parseInt(value, 10), 1, 16384);
          break;
        case "s":
          shortEdge = this.clampInt(parseInt(value, 10), 1, 16384);
          break;
        case "limit":
          limitEnabled = value !== "0";
          break;
        case "color":
          padColor = value;
          break;
      }
    }

    // 百分比缩放：使用 ratio
    if (hasPercentage) {
      edits.resize = {
        ratio: percentage / 100,
        fit: "inside" as const,
      };
      if (!limitEnabled) {
        edits.resize.withoutEnlargement = false;
      }
      return;
    }

    // 长边/短边模式
    if (longEdge !== undefined || shortEdge !== undefined) {
      // 当指定了 w 或 h 时，l/s 不生效
      if (resizeOptions.width === undefined && resizeOptions.height === undefined) {
        if (longEdge !== undefined && shortEdge !== undefined) {
          // 同时设置 l 和 s 时，基于保持长宽比原则，m 参数生效
          resizeOptions.width = longEdge;
          resizeOptions.height = shortEdge;
        } else if (longEdge !== undefined) {
          // 仅指定长边，另一边按比例自动调整
          resizeOptions.width = longEdge;
          resizeOptions.height = longEdge;
          mode = "lfit"; // 长边模式下 m 参数不起作用
        } else if (shortEdge !== undefined) {
          // 仅指定短边，另一边按比例自动调整
          resizeOptions.width = shortEdge;
          resizeOptions.height = shortEdge;
          mode = "mfit"; // 短边模式：确保短边达到指定值
        }
      }
    }

    // 设置 Sharp fit 模式
    const sharpFit = ALI_MODE_TO_SHARP_FIT[mode] || "inside";
    resizeOptions.fit = sharpFit;

    // 处理 pad 模式的背景颜色
    if (mode === "pad") {
      const color = padColor || "FFFFFF";
      resizeOptions.background = this.hexToRgb(color);
    }

    // 处理 fill 模式：需要居中裁剪
    if (mode === "fill") {
      resizeOptions.position = "centre";
    }

    // 处理 limit 参数
    if (!limitEnabled) {
      resizeOptions.withoutEnlargement = false;
    }

    edits.resize = resizeOptions;
  }

  /**
   * 解析 quality 操作的参数
   * 阿里云支持两种质量参数：
   *   q — 相对质量，基于原图质量按百分比压缩
   *   Q — 绝对质量，直接设定目标质量值
   *
   * Sharp 的 quality 参数等同于绝对质量。
   * 对于相对质量，由于无法在处理前获知原图质量，这里近似处理为绝对质量。
   *
   * @param params 参数数组，如 ["q_90"] 或 ["Q_80"]
   * @param edits 编辑操作对象
   */
  private parseQuality(params: string[], edits: ImageEdits): void {
    for (const param of params) {
      const underscoreIndex = param.indexOf("_");
      if (underscoreIndex === -1) continue;

      const key = param.substring(0, underscoreIndex);
      const value = this.clampInt(parseInt(param.substring(underscoreIndex + 1), 10), 1, 100);

      if (key === "q" || key === "Q") {
        edits.jpeg = { quality: value };
      }
    }
  }

  /**
   * 将十六进制颜色值转换为 RGB 对象
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const sanitized = hex.replace(/^#/, "");
    const bigint = parseInt(sanitized, 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255,
    };
  }

  /**
   * 将数值限制在指定范围内
   */
  private clampInt(value: number, min: number, max: number): number {
    if (isNaN(value)) return min;
    return Math.max(min, Math.min(max, value));
  }
}
