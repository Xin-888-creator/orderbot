/**
 * Minnan Food WhatsApp Order Bot
 * Rule-based workflow. No AI.
 *
 * Main flow:
 * NEW/non-order -> welcome + order website
 * order -> request address
 * text address -> geocode -> send location -> address buttons
 * address correct -> phone confirmation
 * phone: use WhatsApp number OR add +60 number
 * final confirmation -> order completed
 *
 * Human takeover buttons:
 * - Transfer to human
 * - Food details
 * - Modify order
 *
 * IMPORTANT:
 * 1) Keep WHATSAPP_TOKEN out of GitHub.
 * 2) Put secrets in Cloudflare Worker Secrets.
 * 3) This code assumes Cloudflare D1.
 */

const STATES = Object.freeze({
  NEW: "NEW",
  WAITING_ADDRESS: "WAITING_ADDRESS",
  WAITING_ADDRESS_CONFIRM: "WAITING_ADDRESS_CONFIRM",
  WAITING_PHONE_CONFIRM: "WAITING_PHONE_CONFIRM",
  WAITING_PHONE_INPUT: "WAITING_PHONE_INPUT",
  WAITING_ORDER_CONFIRM: "WAITING_ORDER_CONFIRM",
  HUMAN_TAKEOVER: "HUMAN_TAKEOVER",
  COMPLETED: "COMPLETED"
});

const MSG = Object.freeze({
  welcome: (url) =>
    `您好，欢迎来到闽南小吃！\\n\\n如需下单，请点击以下网址选择您需要的食品并加入购物车：\\n${url}\\n\\n选择完成后，请点击 WhatsApp 下单，我们会继续为您确认配送信息。`,
  askAddress:
    "您好，已收到您的订单。\\n\\n请直接发送您的配送地址文字信息。\\n\\n建议提供：门牌号、小区/公寓名称、区域。",
  addressNotFound:
    "抱歉，我们暂时无法识别这个地址。\\n\\n请重新发送完整配送地址。\\n建议提供：门牌号、小区/公寓名称、区域。",
  addressConfirm: (address) =>
    `已找到以下配送位置：\\n\\n📍 ${address}\\n\\n请确认配送位置是否正确。`,
  addressWrong:
    "好的，请重新发送您的配送地址。\\n\\n建议位置信息包含：门牌号、小区/公寓名称、区域。",
  phonePrompt: (phone) =>
    `接下来请确认联系手机号码。\\n\\n联系号码：${phone}\\n\\n注意：必须使用马来西亚号码。\\n\\n请确认是否使用此号码作为联系号码。`,
  phoneRejected:
    "抱歉，此号码格式不正确。\\n\\n请添加以 +60 开头的马来西亚手机号码。\\n例如：+60123456789",
  askPhone:
    "好的，请直接发送您的联系手机号码。\\n\\n必须使用以 +60 开头的马来西亚号码。\\n例如：+60123456789",
  orderConfirm: ({itemsText, totalText, address, phone}) =>
    `请确认您的订单：\\n\\n${itemsText}\\n\\n总计：${totalText}\\n\\n配送地址：\\n${address}\\n\\n联系号码：\\n${phone}\\n\\n请确认以上信息是否正确。`,
  orderDone:
    "好的，您的订单已经确认。\\n\\n我们已经收到您的订单，并会根据您提供的信息进行安排。\\n谢谢您的支持！",
  human:
    "好的，已通知人工客服，请稍候。",
  humanNoHistory:
    "好的，已通知人工客服，请稍候。"
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function html(body) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function normalizePhone(phone) {
  if (!phone) return "";
  const raw = String(phone).trim().replace(/[^\d+]/g, "");
  if (raw.startsWith("+")) return raw;
  return `+${raw}`;
}

function isValidMYPlus60(phone) {
  return /^\\+60\\d{8,10}$/.test(String(phone).replace(/[\\s-]/g, ""));
}

function normalizePhoneInput(phone) {
  return String(phone || "").trim().replace(/[\\s()-]/g, "");
}

function formatPhone(phone) {
  const normalized = normalizePhone(phone);
  if (/^\\+60\\d{8,10}$/.test(normalized)) {
    // Simple human-readable format for Malaysian numbers.
    const digits = normalized.slice(3);
    if (digits.length === 9) {
      return `+60 ${digits.slice(0,2)}-${digits.slice(2,5)} ${digits.slice(5)}`;
    }
    if (digits.length === 10) {
      return `+60 ${digits.slice(0,2)}-${digits.slice(2,6)} ${digits.slice(6)}`;
    }
  }
  return normalized;
}

function isOrderText(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  // Your website-generated order currently contains these markers.
  // Adjust these markers if your actual website uses different wording.
  const hasOrderMarker = t.includes("订单明细") || t.includes("order details");
  const hasTotal = /总计\\s*[:：]\\s*rm\\s*\\d/i.test(t) || /total\\s*[:：]?\\s*rm\\s*\\d/i.test(t);
  const hasItemBullet = /(^|\\n)\\s*[•\\-*]\\s*.+?x\\s*\\d+/i.test(t);
  return hasOrderMarker && (hasTotal || hasItemBullet);
}

function parseMoney(text) {
  const m = String(text).match(/(?:总计|total)\\s*[:：]?\\s*rm\\s*(\\d+(?:\\.\\d{1,2})?)/i);
  return m ? Number(m[1]) : null;
}

function parseOrder(text) {
  const raw = String(text || "").trim();
  const lines = raw.split(/\\r?\\n/).map((x) => x.trim()).filter(Boolean);

  const items = [];
  for (const line of lines) {
    // Examples:
    // • 生面（1斤）（碱面需提前说） x 1
    // - 生面 x 2
    const m = line.match(/^[•\\-*]\\s*(.+?)\\s*x\\s*(\\d+)\\s*$/i);
    if (!m) continue;
    items.push({
      name: m[1].trim(),
      quantity: Number(m[2])
    });
  }

  const subtotal = parseMoney(raw);

  return {
    items,
    subtotal,
    raw
  };
}

function itemsToText(items) {
  if (!items?.length) return "• （订单商品读取异常，请转人工）";
  return items.map((i) => `• ${i.name} × ${i.quantity}`).join("\\n");
}

function moneyText(amount) {
  if (typeof amount !== "number" || Number.isNaN(amount)) return "RM 0.00";
  return `RM ${amount.toFixed(2)}`;
}

function makeInternalId() {
  return crypto.randomUUID();
}

async function getCustomer(env, whatsappId) {
  return env.DB.prepare(
    "SELECT * FROM customers WHERE whatsapp_id = ?1"
  ).bind(whatsappId).first();
}

async function upsertCustomer(env, whatsappId, displayName = null) {
  await env.DB.prepare(`
    INSERT INTO customers (whatsapp_id, display_name)
    VALUES (?1, ?2)
    ON CONFLICT(whatsapp_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, customers.display_name),
      updated_at = CURRENT_TIMESTAMP
  `).bind(whatsappId, displayName).run();

  return getCustomer(env, whatsappId);
}

async function updateCustomer(env, whatsappId, fields) {
  const allowed = [
    "state",
    "human_takeover",
    "human_reason",
    "contact_phone",
    "address_text",
    "address_formatted",
    "latitude",
    "longitude"
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = ?${values.length + 1}`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return;
  values.push(whatsappId);
  await env.DB.prepare(
    `UPDATE customers SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE whatsapp_id = ?${values.length}`
  ).bind(...values).run();
}

async function getOpenOrder(env, customerId) {
  return env.DB.prepare(`
    SELECT * FROM orders
    WHERE customer_id = ?1 AND status = 'OPEN'
    ORDER BY id DESC
    LIMIT 1
  `).bind(customerId).first();
}

async function createOrder(env, customerId, parsed) {
  const result = await env.DB.prepare(`
    INSERT INTO orders (customer_id, status, items_json, raw_text, subtotal)
    VALUES (?1, 'OPEN', ?2, ?3, ?4)
  `).bind(
    customerId,
    JSON.stringify(parsed.items),
    parsed.raw,
    parsed.subtotal
  ).run();

  return result.meta?.last_row_id;
}

async function updateOpenOrder(env, customerId, fields) {
  const order = await getOpenOrder(env, customerId);
  if (!order) return null;

  const allowed = [
    "address_text",
    "address_formatted",
    "latitude",
    "longitude",
    "contact_phone",
    "status"
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = ?${values.length + 1}`);
      values.push(fields[key]);
    }
  }
  if (!sets.length) return order;
  values.push(order.id);

  await env.DB.prepare(
    `UPDATE orders SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?${values.length}`
  ).bind(...values).run();

  return env.DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(order.id).first();
}

function graphUrl(env) {
  const version = env.WHATSAPP_GRAPH_VERSION || "v23.0";
  return `https://graph.facebook.com/${version}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
}

async function whatsappRequest(env, payload) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    throw new Error("Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  }

  const response = await fetch(graphUrl(env), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`WhatsApp API error ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendText(env, to, body, footerActions = true) {
  // WhatsApp interactive reply buttons allow only a limited number of reply buttons.
  // We use 3 core actions in normal states:
  // Transfer to human / Food details / Modify order.
  // Confirmation steps use a separate action set.
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  };

  if (!env.TEST_MODE && footerActions) {
    return sendMainActions(env, to, body);
  }

  if (env.TEST_MODE) {
    return { test: true, type: "text", to, body, buttons: footerActions ? mainActionPreview() : [] };
  }

  return whatsappRequest(env, payload);
}

function mainActionPreview() {
  return [
    { id: "HUMAN", title: "转人工" },
    { id: "FOOD_DETAILS", title: "询问食物详情" },
    { id: "MODIFY_ORDER", title: "修改订单" }
  ];
}

async function sendMainActions(env, to, body) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: "HUMAN", title: "转人工" } },
          { type: "reply", reply: { id: "FOOD_DETAILS", title: "询问食物详情" } },
          { type: "reply", reply: { id: "MODIFY_ORDER", title: "修改订单" } }
        ]
      }
    }
  };
  return whatsappRequest(env, payload);
}

async function sendButtons(env, to, body, buttons) {
  const normalized = buttons.slice(0, 3);
  if (env.TEST_MODE) {
    return {
      test: true,
      type: "buttons",
      to,
      body,
      buttons: normalized
    };
  }

  return whatsappRequest(env, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: normalized.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) }
        }))
      }
    }
  });
}

async function sendLocation(env, to, { latitude, longitude, name, address }) {
  if (env.TEST_MODE) {
    return {
      test: true,
      type: "location",
      to,
      latitude,
      longitude,
      name,
      address
    };
  }

  return whatsappRequest(env, {
    messaging_product: "whatsapp",
    to,
    type: "location",
    location: {
      latitude: String(latitude),
      longitude: String(longitude),
      name: name || "配送位置",
      address: address || ""
    }
  });
}

async function geocodeAddress(env, addressText) {
  if (!env.GOOGLE_MAPS_API_KEY) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY");
  }

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(addressText)}` +
    `&region=my&language=en` +
    `&key=${encodeURIComponent(env.GOOGLE_MAPS_API_KEY)}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);

  const data = await response.json();
  if (data.status !== "OK" || !data.results?.length) {
    return null;
  }

  const first = data.results[0];
  const location = first.geometry?.location;
  if (!location) return null;

  return {
    formattedAddress: first.formatted_address,
    latitude: location.lat,
    longitude: location.lng,
    name: first.address_components?.find((c) =>
      ["premise", "point_of_interest", "establishment"].includes(c.types?.[0])
    )?.long_name || "配送位置"
  };
}

async function notifyHuman(env, customer, reason) {
  if (!env.HUMAN_NOTIFICATION_TO || env.TEST_MODE) {
    return;
  }

  const customerPhone = normalizePhone(customer.whatsapp_id);
  const text =
    `🔴 需要人工处理\\n\\n` +
    `客户：${customerPhone}\\n` +
    `原因：${reason}\\n` +
    `状态：机器人已停止自动回复。`;

  try {
    await whatsappRequest(env, {
      messaging_product: "whatsapp",
      to: normalizePhone(env.HUMAN_NOTIFICATION_TO),
      type: "text",
      text: { body: text }
    });
  } catch (error) {
    console.error("Human notification failed:", error);
  }
}

async function takeOverHuman(env, customer, reason) {
  await updateCustomer(env, customer.whatsapp_id, {
    state: STATES.HUMAN_TAKEOVER,
    human_takeover: 1,
    human_reason: reason
  });

  await notifyHuman(env, customer, reason);

  return sendText(env, customer.whatsapp_id, MSG.human, false);
}

async function handleAction(env, customer, actionId) {
  if (customer.human_takeover || customer.state === STATES.HUMAN_TAKEOVER) {
    return null; // Do not auto-reply after human takeover.
  }

  switch (actionId) {
    case "HUMAN":
      return takeOverHuman(env, customer, "客户主动要求人工");

    case "FOOD_DETAILS":
      return takeOverHuman(env, customer, "客户询问食物详情");

    case "MODIFY_ORDER":
      return takeOverHuman(env, customer, "客户要求修改订单");

    case "ADDRESS_CORRECT": {
      const order = await getOpenOrder(env, customer.id);
      if (!order || !customer.address_formatted) {
        return sendText(env, customer.whatsapp_id, MSG.addressWrong, true);
      }

      await updateOpenOrder(env, customer.id, {
        address_formatted: customer.address_formatted,
        latitude: customer.latitude,
        longitude: customer.longitude
      });

      const currentPhone = normalizePhone(customer.whatsapp_id);

      await updateCustomer(env, customer.whatsapp_id, {
        state: STATES.WAITING_PHONE_CONFIRM
      });

      // This step deliberately has its own buttons instead of the three human buttons.
      return sendButtons(env, customer.whatsapp_id, MSG.phonePrompt(formatPhone(currentPhone)), [
        { id: "USE_ACCOUNT_PHONE", title: "使用本账号联系号码" },
        { id: "ADD_PHONE", title: "添加联系号码" }
      ]);
    }

    case "ADDRESS_WRONG":
      await updateCustomer(env, customer.whatsapp_id, {
        state: STATES.WAITING_ADDRESS
      });
      return sendText(env, customer.whatsapp_id, MSG.addressWrong, true);

    case "USE_ACCOUNT_PHONE": {
      const phone = normalizePhone(customer.whatsapp_id);
      if (!isValidMYPlus60(phone)) {
        await updateCustomer(env, customer.whatsapp_id, {
          state: STATES.WAITING_PHONE_INPUT
        });
        return sendText(env, customer.whatsapp_id, MSG.phoneRejected, true);
      }

      await updateCustomer(env, customer.whatsapp_id, {
        state: STATES.WAITING_ORDER_CONFIRM,
        contact_phone: phone
      });
      await updateOpenOrder(env, customer.id, { contact_phone: phone });

      return sendOrderConfirmation(env, customer);
    }

    case "ADD_PHONE":
      await updateCustomer(env, customer.whatsapp_id, {
        state: STATES.WAITING_PHONE_INPUT
      });
      return sendText(env, customer.whatsapp_id, MSG.askPhone, true);

    case "CONFIRM_ORDER": {
      const order = await getOpenOrder(env, customer.id);
      if (!order) {
        return sendText(env, customer.whatsapp_id, "找不到当前订单，请重新从网站下单。", false);
      }

      await env.DB.prepare(`
        UPDATE orders
        SET status = 'CONFIRMED', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?1
      `).bind(order.id).run();

      await updateCustomer(env, customer.whatsapp_id, {
        state: STATES.COMPLETED
      });

      return sendText(env, customer.whatsapp_id, MSG.orderDone, false);
    }

    default:
      return null;
  }
}

async function sendOrderConfirmation(env, customer) {
  const order = await getOpenOrder(env, customer.id);
  if (!order) {
    return sendText(env, customer.whatsapp_id, "找不到当前订单，请重新下单。", false);
  }

  const items = JSON.parse(order.items_json || "[]");
  const address = order.address_formatted || customer.address_formatted || customer.address_text || "未确认";
  const phone = order.contact_phone || customer.contact_phone || normalizePhone(customer.whatsapp_id);

  const body = MSG.orderConfirm({
    itemsText: itemsToText(items),
    totalText: moneyText(order.subtotal),
    address,
    phone: formatPhone(phone)
  });

  return sendButtons(env, customer.whatsapp_id, body, [
    { id: "CONFIRM_ORDER", title: "确认订单" },
    { id: "MODIFY_ORDER", title: "修改订单" },
    { id: "HUMAN", title: "转人工" }
  ]);
}

async function handleAddressText(env, customer, text) {
  const trimmed = String(text || "").trim();
  await updateCustomer(env, customer.whatsapp_id, {
    state: STATES.WAITING_ADDRESS_CONFIRM,
    address_text: trimmed
  });

  const result = await geocodeAddress(env, trimmed);

  if (!result) {
    await updateCustomer(env, customer.whatsapp_id, {
      state: STATES.WAITING_ADDRESS
    });
    return sendText(env, customer.whatsapp_id, MSG.addressNotFound, true);
  }

  await updateCustomer(env, customer.whatsapp_id, {
    state: STATES.WAITING_ADDRESS_CONFIRM,
    address_formatted: result.formattedAddress,
    latitude: result.latitude,
    longitude: result.longitude
  });

  await updateOpenOrder(env, customer.id, {
    address_text: trimmed,
    address_formatted: result.formattedAddress,
    latitude: result.latitude,
    longitude: result.longitude
  });

  await sendLocation(env, customer.whatsapp_id, result);

  return sendButtons(env, customer.whatsapp_id, MSG.addressConfirm(result.formattedAddress), [
    { id: "ADDRESS_CORRECT", title: "地址正确" },
    { id: "ADDRESS_WRONG", title: "地址错误" },
    { id: "HUMAN", title: "转人工" }
  ]);
}

async function handlePhoneText(env, customer, text) {
  const phone = normalizePhoneInput(text);

  if (!isValidMYPlus60(phone)) {
    return sendText(env, customer.whatsapp_id, MSG.phoneRejected, true);
  }

  await updateCustomer(env, customer.whatsapp_id, {
    state: STATES.WAITING_ORDER_CONFIRM,
    contact_phone: phone
  });
  await updateOpenOrder(env, customer.id, { contact_phone: phone });

  const refreshed = await getCustomer(env, customer.whatsapp_id);
  return sendOrderConfirmation(env, refreshed);
}

async function handleIncomingText(env, whatsappId, text, displayName = null) {
  let customer = await upsertCustomer(env, whatsappId, displayName);

  if (customer.human_takeover || customer.state === STATES.HUMAN_TAKEOVER) {
    return { handled: true, replies: [] };
  }

  // Fresh or completed customer sends a new non-order message -> website.
  if ((customer.state === STATES.NEW || customer.state === STATES.COMPLETED) && !isOrderText(text)) {
    return {
      handled: true,
      replies: [await sendText(env, whatsappId, MSG.welcome(env.ORDER_WEBSITE_URL), true)]
    };
  }

  // New order.
  if (isOrderText(text) && [STATES.NEW, STATES.COMPLETED].includes(customer.state)) {
    const parsed = parseOrder(text);

    if (!parsed.items.length) {
      return {
        handled: true,
        replies: [
          await sendText(
            env,
            whatsappId,
            "已收到您的消息，但订单内容似乎无法读取。请重新从网站点击 WhatsApp 下单，或选择转人工。",
            true
          )
        ]
      };
    }

    // Prevent duplicate order creation if the exact order is sent twice.
    const openOrder = await getOpenOrder(env, customer.id);
    if (!openOrder) {
      await createOrder(env, customer.id, parsed);
    }

    await updateCustomer(env, whatsappId, {
      state: STATES.WAITING_ADDRESS
    });

    return {
      handled: true,
      replies: [await sendText(env, whatsappId, MSG.askAddress, true)]
    };
  }

  // Fixed workflow states.
  if (customer.state === STATES.WAITING_ADDRESS) {
    return {
      handled: true,
      replies: [await handleAddressText(env, customer, text)]
    };
  }

  if (customer.state === STATES.WAITING_PHONE_INPUT) {
    return {
      handled: true,
      replies: [await handlePhoneText(env, customer, text)]
    };
  }

  // If a user types instead of pressing a button during confirmation steps.
  if (customer.state === STATES.WAITING_ADDRESS_CONFIRM) {
    return {
      handled: true,
      replies: [
        await sendText(
          env,
          whatsappId,
          "请使用上方的「地址正确」或「地址错误」按钮继续；如需帮助，也可以选择转人工。",
          true
        )
      ]
    };
  }

  if (customer.state === STATES.WAITING_PHONE_CONFIRM) {
    return {
      handled: true,
      replies: [
        await sendText(
          env,
          whatsappId,
          "请使用上方按钮选择「使用本账号联系号码」或「添加联系号码」。",
          false
        )
      ]
    };
  }

  if (customer.state === STATES.WAITING_ORDER_CONFIRM) {
    return {
      handled: true,
      replies: [
        await sendText(
          env,
          whatsappId,
          "请使用上方按钮确认订单，或选择修改订单/转人工。",
          false
        )
      ]
    };
  }

  return {
    handled: true,
    replies: [
      await sendText(env, whatsappId, MSG.welcome(env.ORDER_WEBSITE_URL), true)
    ]
  };
}

async function handleIncoming(env, event) {
  const value = event?.entry?.[0]?.changes?.[0]?.value;
  const messages = value?.messages || [];

  const replies = [];
  for (const message of messages) {
    const from = message?.from;
    if (!from) continue;

    const customer = await upsertCustomer(
      env,
      from,
      value?.contacts?.[0]?.profile?.name || null
    );

    if (customer.human_takeover || customer.state === STATES.HUMAN_TAKEOVER) {
      continue;
    }

    if (message.type === "text") {
      const result = await handleIncomingText(
        env,
        from,
        message.text?.body || "",
        value?.contacts?.[0]?.profile?.name || null
      );
      replies.push(...(result.replies || []));
      continue;
    }

    if (message.type === "location") {
      if (customer.state !== STATES.WAITING_ADDRESS) {
        continue;
      }

      const location = {
        latitude: Number(message.location?.latitude),
        longitude: Number(message.location?.longitude),
        name: message.location?.name || "客户发送的位置",
        address: message.location?.address || ""
      };

      if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) {
        replies.push(await sendText(env, from, MSG.addressNotFound, true));
        continue;
      }

      await updateCustomer(env, from, {
        state: STATES.WAITING_ADDRESS_CONFIRM,
        address_formatted: location.address || location.name,
        latitude: location.latitude,
        longitude: location.longitude
      });

      await updateOpenOrder(env, customer.id, {
        address_formatted: location.address || location.name,
        latitude: location.latitude,
        longitude: location.longitude
      });

      replies.push(await sendLocation(env, from, location));
      replies.push(
        await sendButtons(env, from, MSG.addressConfirm(location.address || location.name), [
          { id: "ADDRESS_CORRECT", title: "地址正确" },
          { id: "ADDRESS_WRONG", title: "地址错误" },
          { id: "HUMAN", title: "转人工" }
        ])
      );
      continue;
    }

    if (message.type === "interactive") {
      const interactive = message.interactive;
      const actionId =
        interactive?.button_reply?.id ||
        interactive?.list_reply?.id ||
        null;

      if (actionId) {
        const result = await handleAction(env, customer, actionId);
        if (result) replies.push(result);
      }
    }
  }

  return { ok: true, replies };
}

function extractTestMessage(body) {
  return {
    from: String(body.session || "601122334455"),
    displayName: String(body.name || "Test Customer"),
    type: body.type || "text",
    text: body.text || "",
    actionId: body.actionId || null,
    latitude: body.latitude,
    longitude: body.longitude,
    locationName: body.locationName || null,
    locationAddress: body.locationAddress || null
  };
}

async function testMessage(env, msg) {
  const customer = await upsertCustomer(env, msg.from, msg.displayName);

  if (customer.human_takeover || customer.state === STATES.HUMAN_TAKEOVER) {
    return { replies: [], state: customer.state, human_takeover: true };
  }

  if (msg.type === "action") {
    const reply = await handleAction(env, customer, msg.actionId);
    const refreshed = await getCustomer(env, msg.from);
    return {
      replies: reply ? [reply] : [],
      state: refreshed.state,
      human_takeover: Boolean(refreshed.human_takeover)
    };
  }

  if (msg.type === "location") {
    const location = {
      latitude: Number(msg.latitude),
      longitude: Number(msg.longitude),
      name: msg.locationName || "Test Location",
      address: msg.locationAddress || "Test Address"
    };

    await updateCustomer(env, msg.from, {
      state: STATES.WAITING_ADDRESS_CONFIRM,
      address_formatted: location.address,
      latitude: location.latitude,
      longitude: location.longitude
    });

    await updateOpenOrder(env, customer.id, {
      address_formatted: location.address,
      latitude: location.latitude,
      longitude: location.longitude
    });

    const replies = [
      await sendLocation(env, msg.from, location),
      await sendButtons(env, msg.from, MSG.addressConfirm(location.address), [
        { id: "ADDRESS_CORRECT", title: "地址正确" },
        { id: "ADDRESS_WRONG", title: "地址错误" },
        { id: "HUMAN", title: "转人工" }
      ])
    ];

    const refreshed = await getCustomer(env, msg.from);
    return { replies, state: refreshed.state, human_takeover: Boolean(refreshed.human_takeover) };
  }

  const result = await handleIncomingText(env, msg.from, msg.text, msg.displayName);
  const refreshed = await getCustomer(env, msg.from);
  return {
    replies: result.replies || [],
    state: refreshed.state,
    human_takeover: Boolean(refreshed.human_takeover)
  };
}

function testPage() {
  return html(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>闽南小吃 WhatsApp Bot 测试</title>
<style>
body{font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px}
.wrap{max-width:760px;margin:0 auto;background:white;border-radius:14px;padding:20px}
.chat{height:520px;overflow:auto;border:1px solid #ddd;border-radius:10px;padding:12px;background:#fafafa}
.msg{margin:10px 0;padding:10px 12px;border-radius:10px;white-space:pre-wrap}
.user{background:#e9f5ff}
.bot{background:#f0f0f0}
.controls{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
button,input{font-size:16px;padding:10px;border-radius:8px;border:1px solid #ccc}
input{flex:1;min-width:240px}
.small{font-size:13px;color:#666}
.action{background:white;cursor:pointer}
</style>
</head>
<body>
<div class="wrap">
<h2>闽南小吃 WhatsApp Bot 测试</h2>
<div class="small">这个页面模拟客户，不连接真实 WhatsApp。测试数据库状态会真实写入 D1。</div>
<p>测试账号：<input id="session" value="601122334455"></p>
<div id="chat" class="chat"></div>
<div class="controls">
<input id="text" placeholder="输入客户消息，例如 Hi / 订单 / 地址 / +60123456789">
<button onclick="sendText()">发送</button>
<button onclick="sendLocation()">模拟发送位置</button>
<button onclick="resetSession()">重置测试</button>
</div>
<div id="actions" class="controls"></div>
<script>
const chat=document.getElementById('chat');
const textEl=document.getElementById('text');
const sessionEl=document.getElementById('session');

function add(role,text){
  const d=document.createElement('div');
  d.className='msg '+role;
  d.textContent=text;
  chat.appendChild(d);
  chat.scrollTop=chat.scrollHeight;
}
function renderReplies(replies){
  const actions=document.getElementById('actions');
  actions.innerHTML='';
  for(const r of replies||[]){
    if(r.type==='text'){
      add('bot',r.body);
      for(const b of (r.buttons||[])) addButton(b);
    } else if(r.type==='buttons'){
      add('bot',r.body);
      for(const b of (r.buttons||[])) addButton(b);
    } else if(r.type==='location'){
      add('bot','📍 '+(r.name||'位置')+'\\n'+(r.address||'')+'\\n('+r.latitude+', '+r.longitude+')');
    }
  }
}
function addButton(b){
  const btn=document.createElement('button');
  btn.className='action';
  btn.textContent=b.title;
  btn.onclick=()=>sendAction(b.id);
  document.getElementById('actions').appendChild(btn);
}
async function api(payload){
  const r=await fetch('/test/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,session:sessionEl.value})});
  const d=await r.json();
  if(!r.ok){add('bot','ERROR: '+JSON.stringify(d));return}
  renderReplies(d.replies);
  add('bot','[state: '+d.state+(d.human_takeover?' / HUMAN TAKEOVER':'')+']');
}
async function sendText(){
  const t=textEl.value.trim(); if(!t)return;
  add('user',t); textEl.value='';
  await api({type:'text',text:t});
}
async function sendAction(actionId){
  add('user','点击：'+actionId);
  await api({type:'action',actionId});
}
async function sendLocation(){
  add('user','📍 发送位置：A-12-08, Sunway Geo Residences');
  await api({
    type:'location',
    latitude:3.0698,
    longitude:101.6072,
    locationName:'Sunway Geo Residences',
    locationAddress:'Sunway Geo Residences, Bandar Sunway, Petaling Jaya'
  });
}
async function resetSession(){
  await fetch('/test/reset?session='+encodeURIComponent(sessionEl.value),{method:'POST'});
  chat.innerHTML=''; document.getElementById('actions').innerHTML='';
  add('bot','测试账号已重置。现在可以发 Hi。');
}
add('bot','开始测试：先发送 Hi，再测试网站订单流程。');
</script>
</div>
</body>
</html>`);
}

async function resetTest(env, session) {
  const c = await getCustomer(env, session);
  if (!c) return;
  await env.DB.prepare("DELETE FROM orders WHERE customer_id = ?1").bind(c.id).run();
  await env.DB.prepare(`
    UPDATE customers
    SET state='NEW',
        human_takeover=0,
        human_reason=NULL,
        contact_phone=NULL,
        address_text=NULL,
        address_formatted=NULL,
        latitude=NULL,
        longitude=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE whatsapp_id = ?1
  `).bind(session).run();
}

function webhookVerification(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge || "", { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // Health check.
      if (url.pathname === "/" && request.method === "GET") {
        return json({
          ok: true,
          service: "minnan-whatsapp-order-bot",
          mode: env.TEST_MODE === "true" ? "TEST" : "LIVE"
        });
      }

      // Browser workflow test.
      if (url.pathname === "/test" && request.method === "GET") {
        return testPage();
      }

      if (url.pathname === "/test/message" && request.method === "POST") {
        const body = await request.json();
        const msg = extractTestMessage(body);
        const result = await testMessage(env, msg);
        return json(result);
      }

      if (url.pathname === "/test/reset" && request.method === "POST") {
        const session = url.searchParams.get("session");
        if (!session) return json({ error: "session required" }, 400);
        await resetTest(env, session);
        return json({ ok: true });
      }

      // WhatsApp webhook verification.
      if (url.pathname === "/webhook" && request.method === "GET") {
        return webhookVerification(request, env);
      }

      // WhatsApp webhook event receiver.
      if (url.pathname === "/webhook" && request.method === "POST") {
        const body = await request.json();
        console.log("WhatsApp webhook:", JSON.stringify(body));
        await handleIncoming(env, body);
        return new Response("EVENT_RECEIVED", { status: 200 });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error(error);
      return json({
        ok: false,
        error: error?.message || String(error)
      }, 500);
    }
  }
};
